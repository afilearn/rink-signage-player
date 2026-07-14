
window.ARENA_SIGNAGE_CONFIG = {
  // Cloudflare Worker URL, without a trailing slash.
  API_URL: "https://post-signage-api.abdullaafraz.workers.dev",
  // Dashboard used on the pairing screen.
  DASHBOARD_URL: "https://app.arenasignage.com/dashboard"
};

;

  (function(){
    function apiBase(){
      var cfg = window.ARENA_SIGNAGE_CONFIG || {};
      return String(cfg.API_URL || 'https://post-signage-api.abdullaafraz.workers.dev').replace(/\/$/, '');
    }
    var CONFIG = {
      POLL_INTERVAL: 60000,
      HEARTBEAT_INTERVAL: 30000,
      DEVICE_STATUS_INTERVAL: 60000,
      COMMAND_POLL_INTERVAL: 8000,
      WATCHDOG_INTERVAL: 5000,
      FREEZE_THRESHOLD: 45000,
      FREEZE_RECOVERY_HOLD: 30000,
      PROGRESS_UPDATE_INTERVAL: 2000,
      DEFAULT_EVENT_DURATION: 90,
      FORCE_12H_CLOCK: true,
      API_TIMEOUT: 8000,
      CACHE_TTL: 86400000,
      RETRY_DELAYS: [1000, 2000, 4000, 8000],
      SCROLL: {
        SPEED: 1,
        INTERVAL: 30,
        PAUSE_TOP: 1500,
        PAUSE_BOTTOM: 3000
      },
      TICKER_SPEED: 100,
      PAGE_INTERVAL: 8000,
      PAGE_FADE: 400
    };
    
    var state = {
      screenCode: '',
      lastPayload: null,
      lastSignature: null,
      networkFailures: 0,
      retryCount: 0,
      userInteracting: false,
      scrollTimer: null,
      scrollPause: null,
      pollHandle: null,
      isRegistered: false,
      lastSuccessfulData: null,
      currentTheme: null,
      combinedLayout: null,
      combinedRinks: []
    };

    var supabaseClient = null;
    var realtimeChannel = null;
    var currentRinkId = null;
    var healthState = null;
    var PLAYER_VERSION = '1.3.8';
    var PLAYER_UPDATED_AT = '2026-07-14T19:10:00.000Z';
    var deviceState = {
      lastContentSyncAt: null,
      lastAdCampaignId: null,
      lastAdName: null,
      commandBusy: false,
      lastErrorByType: {}
    };

    function markContentHealthy() {
      if (healthState && healthState.recoveryPending) {
        healthState.contentHealthyAfterFreeze = true;
      }
    }
    
    function initSupabase() {
      if (typeof window.supabase === 'undefined') {
        console.log('Supabase library not loaded, realtime disabled');
        return;
      }
      
      try {
        supabaseClient = window.supabase.createClient(
          'https://excfbqwqzryjlsrgfpjm.supabase.co',
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4Y2ZicXdxenJ5amxzcmdmcGptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM4NzMwNzMsImV4cCI6MjA2OTQ0OTA3M30.OdYAso9j7j4VIefQ76nI0TSoFtqJIUYcAtX5P9KYf8M'
        );
        console.log('Supabase initialized successfully');
        updateRealtimeStatus('disconnected');
      } catch(e) {
        console.log('Failed to initialize Supabase:', e);
      }
    }
    
    function updateRealtimeStatus(status) {
      var indicator = document.getElementById('realtime-status');
      if (!indicator) return;
      
      indicator.className = status;
      switch(status) {
        case 'connected':
          indicator.textContent = 'Live';
          break;
        case 'connecting':
          indicator.textContent = 'Connecting...';
          break;
        case 'disconnected':
          indicator.textContent = 'Offline';
          break;
      }
    }
    
    function subscribeToRealtime(rinkId) {
      if (!supabaseClient || !rinkId) {
        console.log('Cannot subscribe: missing supabaseClient or rinkId');
        return;
      }
      
      if (realtimeChannel) {
        console.log('Removing existing channel subscription');
        supabaseClient.removeChannel(realtimeChannel);
        realtimeChannel = null;
      }
      
      currentRinkId = rinkId;
      console.log('Subscribing to realtime updates for rink:', rinkId);
      updateRealtimeStatus('connecting');
      
      realtimeChannel = supabaseClient
        .channel('rink-updates-' + rinkId)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'bookings',
            filter: 'rink_id=eq.' + rinkId
          },
          function(payload) {
            console.log('Booking update received:', payload.eventType);
            checkAndLoadEvents(true);
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'rinks',
            filter: 'id=eq.' + rinkId
          },
          function(payload) {
            console.log('Rink update received:', payload.eventType);
            // A device-command insert updates rinks.command_signal_at. Pull immediately
            // instead of waiting for the normal fallback polling interval.
            pollRemoteCommand();
            checkAndLoadEvents(true);
          }
        )
        .subscribe(function(status) {
          console.log('Realtime subscription status:', status);
          if (status === 'SUBSCRIBED') {
            updateRealtimeStatus('connected');
            console.log('Successfully subscribed to realtime updates');
          } else if (status === 'CHANNEL_ERROR') {
            updateRealtimeStatus('disconnected');
            console.log('Realtime subscription error');
          } else if (status === 'TIMED_OUT') {
            updateRealtimeStatus('disconnected');
            console.log('Realtime subscription timed out');
          }
        });
    }

    // Picks a readable clock color for the header: if the header background
    // is light and opaque enough, use near-black; otherwise the theme's
    // time_text (made for dark backgrounds) is fine.
    function contrastTextFor(bg, fallback){
      try {
        if (!bg) return fallback;
        var rC, gC, bC, a = 1, m;
        m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\)/i);
        if (m){ rC = +m[1]; gC = +m[2]; bC = +m[3]; a = m[4] === undefined ? 1 : +m[4]; }
        else {
          m = bg.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
          if (!m) return fallback;
          var hx = m[1];
          if (hx.length === 3) hx = hx[0]+hx[0]+hx[1]+hx[1]+hx[2]+hx[2];
          rC = parseInt(hx.substr(0,2),16); gC = parseInt(hx.substr(2,2),16); bC = parseInt(hx.substr(4,2),16);
        }
        if (a < 0.5) return fallback; // mostly transparent header: page bg dominates
        var lum = (0.2126*rC + 0.7152*gC + 0.0722*bC) / 255;
        return lum > 0.6 ? '#1a1a1a' : fallback;
      } catch(e){ return fallback; }
    }

    function applyTheme(theme) {
      if (!theme) return;
      
      var themeStyle = document.getElementById('custom-theme');
      if (!themeStyle) {
        themeStyle = document.createElement('style');
        themeStyle.id = 'custom-theme';
        document.head.appendChild(themeStyle);
      }
      
      themeStyle.textContent = `
        :root {
          --theme-bg: ${theme.bg_color || '#0a0a0a'};
          --theme-header-bg: ${theme.header_bg || 'rgba(0,0,0,0.3)'};
          --theme-clock-text: ${contrastTextFor(theme.header_bg, theme.time_text || '#dddddd')};
          --theme-accent: ${theme.accent || '#f77436'};
          --theme-event-text: ${theme.event_text || '#ffffff'};
          --theme-time-text: ${theme.time_text || '#dddddd'};
          --theme-room-text: ${theme.room_text || '#cccccc'};
          --theme-live-badge: ${theme.live_badge || '#f77436'};
          --theme-live-bg: ${theme.live_bg || 'rgba(0,0,0,0)'};
          --theme-progress: ${theme.progress_bar || '#f77436'};
          --theme-ticker-bg: ${theme.ticker_bg || 'rgba(11,11,11,0.95)'};
          --theme-ticker-text: ${theme.ticker_text || '#dddddd'};
        }
      `;
    }

    function applyFontScale(scale) {
      if (!scale || scale === 1.0) {
        document.documentElement.style.setProperty('--font-scale', '1');
        return;
      }

      document.documentElement.style.setProperty('--font-scale', scale);
    }

    // ==============================================
    // COMBINED DISPLAY FUNCTIONS
    // ==============================================

    function checkCombinedLayout(rinkData) {
      if (!rinkData) return false;

      var layout = rinkData.layout || 'single';
      if (layout === 'single') return false;

      return layout === '2-up-vertical' && !!rinkData.slot_b_rink_id;
    }

    async function fetchLayoutSettings(rinkId) {
      if (!supabaseClient || !rinkId) return null;

      try {
        var result = await supabaseClient
          .from('rinks')
          .select('layout, slot_b_rink_id')
          .eq('id', rinkId)
          .single();

        if (result.error || !result.data) return null;

        return result.data;
      } catch (e) {
        console.log('Error fetching layout settings:', e);
        return null;
      }
    }

    async function checkAndLoadCombinedIfNeeded(data) {
      if (!data || !data.rink_id) return false;

      // Check if API already provided combined_rinks data (preferred method)
      if (data.combined_rinks && Array.isArray(data.combined_rinks) && data.combined_rinks.length > 1) {
        console.log('>>> LOADING COMBINED DISPLAY (from API)');
        console.log('Layout:', data.layout);
        console.log('Combined rinks count:', data.combined_rinks.length);

        state.combinedLayout = data.layout;
        state.combinedRinks = data.combined_rinks;

        // Apply theme from primary rink
        if (data.theme) {
          var theme = data.theme;
          if (!theme.live_badge && data.theme_live_badge) {
            theme.live_badge = data.theme_live_badge;
          }
          if (!theme.progress_bar && data.theme_progress_bar) {
            theme.progress_bar = data.theme_progress_bar;
          }
          applyTheme(theme);
        }
        if (data.font_scale) {
          applyFontScale(data.font_scale);
        }

        renderCombinedDisplay(data.layout, data.combined_rinks);

        // Combined mode bypasses maybeRender, so run the shared per-poll
        // updates here too: ads column, ticker text, live progress.
        try { updateAds(data && data.ads); } catch(e){}
        try { updateTickerText((data && (data.announcement || data.ticker_text)) || ''); } catch(e){}
        try { updateLiveProgressBars(); } catch(e){}
        return true;
      }

      // Fallback: Fetch layout settings from database if API didn't provide combined_rinks
      if (!supabaseClient) return false;

      var layoutSettings = await fetchLayoutSettings(data.rink_id);

      if (!layoutSettings || !layoutSettings.layout || layoutSettings.layout === 'single') {
        return false;
      }

      // Merge layout settings into data
      data.layout = layoutSettings.layout;
      data.slot_b_rink_id = layoutSettings.slot_b_rink_id;

      if (checkCombinedLayout(data)) {
        console.log('>>> LOADING COMBINED DISPLAY (fallback method)');
        return await loadCombinedDisplay(data);
      }

      return false;
    }

    async function fetchRinkData(rinkId) {
      if (!rinkId) return null;

      try {
        // First, get the screen_code for this rink_id so we can use the API
        // Try to get screen_code from Supabase first
        var screenCode = null;

        if (supabaseClient) {
          try {
            var codeResult = await supabaseClient
              .from('rinks')
              .select('screen_code')
              .eq('id', rinkId)
              .maybeSingle();  // Use maybeSingle to avoid 406 on no results

            if (codeResult.data && codeResult.data.screen_code) {
              screenCode = codeResult.data.screen_code;
            }
          } catch (e) {
            console.log('Could not fetch screen_code from Supabase:', e);
          }
        }

        // If we got a screen_code, use the API endpoint
        if (screenCode) {
          return new Promise(function(resolve) {
            var apiUrl = apiBase() + '?id=' +
                         encodeURIComponent(screenCode);

            var xhr = new XMLHttpRequest();
            xhr.open('GET', apiUrl, true);
            xhr.timeout = CONFIG.API_TIMEOUT;

            xhr.onreadystatechange = function() {
              if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                  try {
                    var data = JSON.parse(xhr.responseText);
                    if (data && data.registered) {
                      resolve({
                        rink_id: data.rink_id,
                        rink_title: data.rink_title,
                        rink_logo: data.rink_logo,
                        ticker_text: data.ticker_text || data.announcement || '',
                        events: data.events || [],
                        theme: data.theme || null,
                        font_scale: data.font_scale
                      });
                    } else {
                      resolve(null);
                    }
                  } catch (e) {
                    console.log('Error parsing rink API response:', e);
                    resolve(null);
                  }
                } else {
                  console.log('API request failed with status:', xhr.status);
                  resolve(null);
                }
              }
            };

            xhr.onerror = function() {
              console.log('API request error');
              resolve(null);
            };

            xhr.ontimeout = function() {
              console.log('API request timeout');
              resolve(null);
            };

            xhr.send(null);
          });
        }

        // Fallback: Try direct Supabase query if no screen_code
        // This may fail due to RLS but we'll try anyway
        if (supabaseClient) {
          var rinkResult = await supabaseClient
            .from('rinks')
            .select('id, name, screen_code, logo_url, ticker_text, theme_bg_color, theme_header_bg, theme_accent, theme_event_text, theme_time_text, theme_room_text, theme_live_badge, theme_live_bg, theme_progress_bar, font_scale')
            .eq('id', rinkId)
            .maybeSingle();  // Use maybeSingle to avoid 406

          if (rinkResult.error || !rinkResult.data) {
            console.log('Supabase rink query failed:', rinkResult.error);
            return null;
          }

          var rink = rinkResult.data;

          // Get today's bookings
          var today = new Date();
          var todayStr = today.getFullYear() + '-' +
                         String(today.getMonth() + 1).padStart(2, '0') + '-' +
                         String(today.getDate()).padStart(2, '0');

          var bookingsResult = await supabaseClient
            .from('bookings')
            .select('*')
            .eq('rink_id', rinkId)
            .lte('date', todayStr)
            .gte('end_date', todayStr)
            .order('date', { ascending: true })
            .order('start_time', { ascending: true });

          var events = [];
          if (!bookingsResult.error && bookingsResult.data) {
            events = bookingsResult.data.map(function(b) {
              return {
                teams: b.teams,
                room: b.room,
                start_time: b.start_time,
                end_time: b.end_time,
                date: b.date,
                end_date: b.end_date
              };
            });
          }

          // Get active announcements
          var now = new Date().toISOString();
          var announcementsResult = await supabaseClient
            .from('announcements')
            .select('message, priority')
            .or('rink_id.eq.' + rinkId + ',rink_id.is.null')
            .lte('start_time', now)
            .gte('end_time', now)
            .order('priority', { ascending: false })
            .limit(1);

          var ticker = '';
          if (!announcementsResult.error && announcementsResult.data && announcementsResult.data.length > 0) {
            ticker = announcementsResult.data[0].message;
          } else if (rink.ticker_text) {
            ticker = rink.ticker_text;
          }

          return {
            rink_id: rink.id,
            rink_title: rink.name,
            rink_logo: rink.logo_url,
            ticker_text: ticker,
            events: events,
            theme: {
              bg_color: rink.theme_bg_color,
              header_bg: rink.theme_header_bg,
              accent: rink.theme_accent,
              event_text: rink.theme_event_text,
              time_text: rink.theme_time_text,
              room_text: rink.theme_room_text,
              live_badge: rink.theme_live_badge,
              live_bg: rink.theme_live_bg,
              progress_bar: rink.theme_progress_bar
            },
            font_scale: rink.font_scale
          };
        }

        return null;
      } catch (e) {
        console.log('Error fetching rink data:', e);
        return null;
      }
    }

    async function loadCombinedDisplay(primaryData) {
      var layout = primaryData.layout;
      var rinkIds = [primaryData.rink_id];

      // ArenaSignage supports single and 2-up vertical layouts only.
      if (layout === '2-up-vertical' && primaryData.slot_b_rink_id) rinkIds.push(primaryData.slot_b_rink_id);

      console.log('=== COMBINED DISPLAY ===');
      console.log('Layout:', layout);
      console.log('Primary rink ID:', primaryData.rink_id);
      console.log('All rink IDs to load:', rinkIds);

      // Fetch data for all rinks
      var rinkDataArray = [];

      // First rink uses primaryData (already have it)
      rinkDataArray.push({
        rink_id: primaryData.rink_id,
        rink_title: primaryData.rink_title,
        rink_logo: primaryData.rink_logo,
        ticker_text: primaryData.ticker_text,
        events: primaryData.events,
        theme: primaryData.theme,
        font_scale: primaryData.font_scale
      });
      console.log('Primary rink loaded:', primaryData.rink_title);

      // Fetch additional rinks
      for (var i = 1; i < rinkIds.length; i++) {
        console.log('Fetching secondary rink:', rinkIds[i]);
        var rinkData = await fetchRinkData(rinkIds[i]);
        if (rinkData) {
          console.log('Secondary rink loaded:', rinkData.rink_title);
          rinkDataArray.push(rinkData);
        } else {
          console.log('Failed to load secondary rink:', rinkIds[i]);
          // Still show a placeholder panel for missing rinks
          rinkDataArray.push({
            rink_id: rinkIds[i],
            rink_title: 'Loading...',
            rink_logo: null,
            ticker_text: '',
            events: [],
            theme: null,
            font_scale: 1
          });
        }
      }

      console.log('Total rinks loaded:', rinkDataArray.length);

      state.combinedLayout = layout;
      state.combinedRinks = rinkDataArray;

      // Apply theme from primary rink
      if (primaryData.theme) {
        var theme = primaryData.theme;
        if (!theme.live_badge && primaryData.theme_live_badge) {
          theme.live_badge = primaryData.theme_live_badge;
        }
        if (!theme.progress_bar && primaryData.theme_progress_bar) {
          theme.progress_bar = primaryData.theme_progress_bar;
        }
        applyTheme(theme);
      }
      if (primaryData.font_scale) {
        applyFontScale(primaryData.font_scale);
      }

      renderCombinedDisplay(layout, rinkDataArray);
      return true;
    }

    function renderCombinedDisplay(layout, rinkDataArray) {
      var container = document.getElementById('combined-display');
      if (!container) return;

      // Clear existing content
      container.innerHTML = '';
      container.className = 'active layout-' + layout;

      // Add body class for combined mode
      document.body.classList.add('combined-mode');

      // Collect all ticker text
      var allTickers = [];

      // The column labels always belong directly below the top rink header.
      // This keeps the visual grid anchored at the top even when that rink is empty.
      // Create panel for each rink
      for (var i = 0; i < rinkDataArray.length; i++) {
        var rinkData = rinkDataArray[i];
        var panel = createRinkPanel(rinkData, i, i === 0);
        container.appendChild(panel);

        if (rinkData.ticker_text) {
          allTickers.push(rinkData.rink_title + ': ' + rinkData.ticker_text);
        }
      }

      // Update ticker with combined announcements
      var combinedTicker = allTickers.join('     \u2022     ');
      updateTickerText(combinedTicker);

      // Show the combined display
      hide('code-screen');
      hide('header');
      hide('event-screen');
      hide('empty-screen');
      dismissOverlay();
    }

    function createRinkPanel(rinkData, index, showColumnHeader) {
      var panel = document.createElement('div');
      panel.className = 'rink-panel';
      panel.id = 'rink-panel-' + index;

      // Get theme colors for this rink (with fallbacks)
      var theme = rinkData.theme || {};
      var colors = {
        bg: theme.bg_color || '#0a0a0a',
        headerBg: theme.header_bg || 'rgba(0,0,0,0.3)',
        accent: theme.accent || '#f77436',
        eventText: theme.event_text || '#ffffff',
        timeText: theme.time_text || '#dddddd',
        roomText: theme.room_text || '#cccccc',
        liveBadge: theme.live_badge || '#f77436',
        liveBg: theme.live_bg || 'rgba(0,0,0,0)',
        progressBar: theme.progress_bar || '#f77436'
      };

      // Apply background color to panel
      panel.style.background = colors.bg;

      var now = new Date();
      var events = filterActiveEvents(rinkData.events || [], now);

      // Panel header
      var header = document.createElement('div');
      header.className = 'rink-panel-header';
      header.style.background = colors.headerBg;

      var headerLeft = document.createElement('div');
      headerLeft.className = 'rink-panel-header-left';

      if (rinkData.rink_logo) {
        var logo = document.createElement('img');
        logo.className = 'rink-panel-logo';
        logo.src = rinkData.rink_logo;
        logo.style.display = 'block';
        logo.onerror = function() { this.style.display = 'none'; };
        headerLeft.appendChild(logo);
      }

      var title = document.createElement('div');
      title.className = 'rink-panel-title';
      title.textContent = rinkData.rink_title || 'Rink';
      title.style.color = colors.accent;
      headerLeft.appendChild(title);

      header.appendChild(headerLeft);

      // Add clock to panel header (only on first panel to avoid duplication)
      if (index === 0) {
        var clock = document.createElement('div');
        clock.className = 'rink-panel-clock';
        clock.id = 'combined-clock';
        clock.textContent = fmtClock(new Date());
        clock.style.color = contrastTextFor(theme.header_bg, colors.timeText);
        header.appendChild(clock);
      }

      panel.appendChild(header);

      // Events container. The top panel always owns the column labels,
      // even when it has no events.
      var eventsContainer = document.createElement('div');
      eventsContainer.className = 'rink-panel-events';

      var html = '';
      if (showColumnHeader) {
        html += '<div class="event-header" style="color:' + colors.roomText + '; border-bottom: 0.3vh solid ' + colors.accent + ';">'
             + '<div class="event-cell time">Time</div>'
             + '<div class="event-cell">Event</div>'
             + '<div class="event-cell room">Room</div>'
             + '</div>';
      }

      if (events.length > 0) {
        for (var j = 0; j < events.length; j++) {
          var ev = events[j];
          var teams = esc(ev.teams || '');
          var startRaw = ev.start_time || '';
          var endRaw = ev.end_time || '';
          var room = esc(ev.room || '');

          var timeStr = '';
          if (startRaw || endRaw) {
            var a = to12h(startRaw);
            var b = to12h(endRaw);
            timeStr = a && b ? (a + ' - ' + b) : (a || b);
          }

          var times = getEventTimes(ev);
          var isLive = false;

          if (times.start) {
            var n = now.getTime();
            var sTime = times.start.getTime();
            var eTime = times.end ? times.end.getTime() : null;

            if (n >= sTime && (eTime === null || n < eTime)) {
              isLive = true;
            }
          }

          var livePillStyle = 'background:' + colors.liveBadge + ';';
          var skipLiveBg = !theme.live_bg || theme.live_bg === 'rgba(31,18,10,0.8)';
          var liveRowStyle = isLive ? (skipLiveBg ? '' : 'background:' + colors.liveBg + ';') + 'border-bottom-color:' + colors.liveBadge + ';' : '';

          html += '<div class="event-row' + (isLive ? ' live' : '') + '" style="' + liveRowStyle + '">'
               + '<div class="event-cell time" style="color:' + colors.timeText + ';">' + timeStr + '</div>'
               + '<div class="event-cell" style="color:' + colors.eventText + ';">' + teams + (isLive ? ' <span class="live-pill" style="' + livePillStyle + '">LIVE</span>' : '') + '</div>'
               + '<div class="event-cell room" style="color:' + colors.roomText + ';">' + room + '</div>'
               + '</div>';

          if (isLive && times.start && times.end) {
            var sMs = times.start.getTime();
            var eMs = times.end.getTime();
            var pct = Math.round(((n - sMs) / (eMs - sMs)) * 100);
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;
            html += '<div class="progress" data-start="' + sMs + '" data-end="' + eMs + '">'
                 + '<div class="progress-fill" style="width:' + pct + '%;background:' + colors.progressBar + ';"></div></div>';
          }
        }
      } else {
        html += '<div class="rink-panel-empty">'
             + '<div class="rink-panel-empty-icon">&#128197;</div>'
             + '<div>No events scheduled</div>'
             + '</div>';
      }

      eventsContainer.innerHTML = html;
      panel.appendChild(eventsContainer);

      return panel;
    }

    function filterActiveEvents(events, now) {
      var filtered = [];

      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var times = getEventTimes(ev);

        if (!times.start && !times.end) continue;
        if (times.end && now.getTime() >= times.end.getTime()) continue;

        ev.__start = times.start ? times.start.getTime() : Number.MAX_SAFE_INTEGER;
        ev.__times = times;
        filtered.push(ev);
      }

      filtered.sort(function(a, b) {
        return a.__start - b.__start;
      });

      return filtered.slice(0, 10); // Limit to 10 events per panel
    }

    function updateCombinedDisplay() {
      if (!state.combinedLayout || !state.combinedRinks || state.combinedRinks.length === 0) return;

      // Re-render panels with updated time/live status
      var container = document.getElementById('combined-display');
      if (!container) return;

      container.innerHTML = '';

      for (var i = 0; i < state.combinedRinks.length; i++) {
        var panel = createRinkPanel(state.combinedRinks[i], i, i === 0);
        container.appendChild(panel);
      }
    }

    function loadCachedTheme() {
      var cachedTheme = getCacheWithExpiry('theme_' + state.screenCode);
      if (cachedTheme) {
        applyTheme(cachedTheme);
      }
    }

    function isPreviewMode() {
      var params = new URLSearchParams(window.location.search);
      return params.get('preview') === 'true';
    }

    function applyPreviewTheme() {
      var params = new URLSearchParams(window.location.search);
      if (params.get('preview') !== 'true') return;
      
      var theme = {
        bg_color: params.get('bg') || '#0a0a0a',
        header_bg: params.get('header') || 'rgba(0,0,0,0.3)',
        accent: params.get('accent') || '#f77436',
        event_text: params.get('event') || '#ffffff',
        time_text: params.get('time') || '#dddddd',
        room_text: params.get('room') || '#cccccc',
        live_badge: params.get('badge') || '#f77436',
        live_bg: 'rgba(31,18,10,0.8)',
        progress_bar: params.get('progress') || '#f77436',
        ticker_bg: 'rgba(11,11,11,0.95)',
        ticker_text: params.get('time') || '#dddddd'
      };
      
      applyTheme(theme);
      
      var badge = document.createElement('div');
      badge.className = 'theme-preview-badge';
      badge.textContent = 'THEME PREVIEW';
      document.body.appendChild(badge);
      
      var sampleData = {
        registered: true,
        rink_title: 'Preview Arena',
        rink_logo: '',
        ticker_text: 'This is a preview of your custom theme • Helmets required • Public skate 7 PM',
        events: [
          {
            teams: 'Hawks vs Eagles',
            room: 'Main Rink',
            start_time: '09:00',
            end_time: '10:30',
            date: new Date().toISOString().split('T')[0]
          },
          {
            teams: 'Junior Practice',
            room: 'Practice Ice',
            start_time: '10:45',
            end_time: '11:45',
            date: new Date().toISOString().split('T')[0]
          },
          {
            teams: 'Figure Skating',
            room: 'Main Rink',
            start_time: '12:00',
            end_time: '13:00',
            date: new Date().toISOString().split('T')[0]
          }
        ],
        theme: theme
      };
      
      var now = new Date();
      var currentHour = now.getHours();
      if (currentHour >= 9 && currentHour < 18) {
        sampleData.events[0].start_time = pad2(currentHour) + ':00';
        sampleData.events[0].end_time = pad2(currentHour + 1) + ':30';
      }
      
      renderFromPayload(sampleData);
    }
    
    if (!window.requestAnimationFrame) {
      window.requestAnimationFrame = window.webkitRequestAnimationFrame || 
                                     window.mozRequestAnimationFrame || 
                                     function(cb){ setTimeout(cb, 1000/60); };
    }
    
    function parseQuery(){ 
      var out = {}; 
      try{ 
        var q = (location.search || '').replace(/^\?/, ''); 
        if (!q) return out; 
        var parts = q.split('&'); 
        for (var i = 0; i < parts.length; i++){ 
          var kv = parts[i].split('='); 
          if (!kv[0]) continue; 
          var k = decodeURIComponent(kv[0]); 
          var v = kv.length > 1 ? decodeURIComponent(kv[1].replace(/\+/g, ' ')) : ''; 
          out[k] = v; 
        } 
      } catch(e){
        console.log('parseQuery error:', e);
      } 
      return out; 
    }
    
    function getLocal(k){ 
      try{ 
        return localStorage ? localStorage.getItem(k) : null; 
      } catch(e){ 
        return null; 
      } 
    }
    
    function setLocal(k, v){ 
      try{ 
        if (localStorage) localStorage.setItem(k, v); 
      } catch(e){} 
    }
    
    function getCacheWithExpiry(key) {
      try {
        var item = getLocal(key);
        if (!item) return null;
        var parsed = JSON.parse(item);
        if (Date.now() > parsed.expiry) {
          localStorage.removeItem(key);
          return null;
        }
        return parsed.data;
      } catch(e) {
        return null;
      }
    }
    
    function setCacheWithExpiry(key, data) {
      try {
        var item = {
          data: data,
          expiry: Date.now() + CONFIG.CACHE_TTL
        };
        setLocal(key, JSON.stringify(item));
      } catch(e) {}
    }
    
    function getRegistrationStatus() {
      var status = getLocal('registration_status_' + state.screenCode);
      return status === 'true';
    }
    
    function setRegistrationStatus(registered) {
      state.isRegistered = registered;
      setLocal('registration_status_' + state.screenCode, registered ? 'true' : 'false');
    }

    var overlayDismissed = false;
    function dismissOverlay() {
      if (overlayDismissed) return;
      overlayDismissed = true;
      var overlay = document.getElementById('boot-overlay');
      if (!overlay) return;
      overlay.classList.add('fade-out');
      setTimeout(function() {
        overlay.parentNode.removeChild(overlay);
      }, 600);
    }
    
    var ESC_MAP = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
    function esc(s){ 
      s = String(s == null ? '' : s); 
      return s.replace(/[&<>"']/g, function(c){ 
        return ESC_MAP[c] || c; 
      }); 
    }
    
    function pad2(n){ 
      return (n < 10 ? '0' : '') + n; 
    }
    
    function show(id){
      var el = document.getElementById(id);
      if (!el) return;
      var disp = (id === 'code-screen' || id === 'empty-screen') ? 'flex' :
                 (id === 'header' ? 'grid' : 'block');
      el.style.display = disp;
      // Trigger fade-in on next frame so the browser registers the display change first
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          el.classList.add('visible');
        });
      });
    }

    function hide(id){
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('visible');
      // For code-screen (starts visible), also force opacity to 0
      el.style.opacity = '0';
      // Hide after fade-out completes
      setTimeout(function() {
        el.style.display = 'none';
        el.style.opacity = '';
      }, 400);
    }
    
    function detectPlatform() {
      var ua = navigator.userAgent.toLowerCase();
      var platform = '';
      
      if (ua.indexOf('webos') !== -1 || ua.indexOf('netcast') !== -1 || window.PalmServiceBridge) {
        platform = 'LG webOS Smart TV';
      } else if (ua.indexOf('tizen') !== -1 || window.tizen) {
        platform = 'Samsung Tizen Smart TV';
      } else if (ua.indexOf('android tv') !== -1 || ua.indexOf('googletv') !== -1) {
        platform = 'Android TV';
      } else if (ua.indexOf('chrome') !== -1) {
        platform = 'Chrome Browser';
      } else {
        platform = 'Web Browser';
      }
      
      var el1 = document.getElementById('platform-indicator');
      var el2 = document.getElementById('platform-info');
      if (el1) el1.textContent = platform;
      if (el2) el2.textContent = platform;
    }
    
    function getOrCreateScreenCode(){
      var q = parseQuery();
      var code = q.code || getLocal('screen_uuid');
      
      if (!code){
        var crypto = window.crypto || window.msCrypto;
        if (crypto && crypto.getRandomValues) {
          var arr = new Uint8Array(16);
          crypto.getRandomValues(arr);
          
          code = Array.from(arr, function(byte) {
            return ('0' + byte.toString(16)).slice(-2);
          }).join('').slice(0, 8).toUpperCase();
        } else {
          var timestamp = Date.now();
          var random = Math.random() * 0x100000000;
          var combined = (timestamp + random).toString(16);
          code = combined.slice(-8).toUpperCase();
          
          var chars = '0123456789ABCDEF';
          for (var i = 0; i < 8; i++) {
            if (Math.random() < 0.3) {
              var pos = Math.floor(Math.random() * 8);
              code = code.substr(0, pos) + chars[Math.floor(Math.random() * 16)] + code.substr(pos + 1);
            }
          }
        }
      }
      
      code = String(code).replace(/\s+/g, '').toUpperCase();
      setLocal('screen_uuid', code);
      state.screenCode = code;
      return code;
    }
    
    var networkStatus = document.getElementById('network-status');
    var net = {failures: 0, lastSuccess: Date.now(), responseTime: 0};
    
    function updateNetworkStatus(status, rt){
      if (!networkStatus) return;
      
      if (status === 'success'){
        net.failures = 0; 
        net.lastSuccess = Date.now(); 
        net.responseTime = rt || 0;
        state.networkFailures = 0;
        
        if (rt < 2000){ 
          networkStatus.className = ''; 
          networkStatus.title = 'Connected'; 
        } else { 
          networkStatus.className = 'slow'; 
          networkStatus.title = 'Slow Connection'; 
        }
      } else {
        net.failures++;
        state.networkFailures++;
        
        if (net.failures < 3 && (Date.now() - net.lastSuccess) < 60000){ 
          networkStatus.className = 'slow'; 
          networkStatus.title = 'Connection Issues'; 
        } else { 
          networkStatus.className = 'offline'; 
          networkStatus.title = 'Connection Lost'; 
        }
      }
    }
    
    function format12(h, m){ 
      var ap = h >= 12 ? 'PM' : 'AM'; 
      h = h % 12; 
      if (h === 0) h = 12; 
      return h + ':' + pad2(m) + ' ' + ap; 
    }
    
    function to12h(input){
      var s = String(input || '').trim(); 
      if (!s) return '';
      
      var rng = s.split(/\s*[-]\s*/); 
      if (rng.length === 2) return to12h(rng[0]) + ' - ' + to12h(rng[1]);
      
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)){ 
        var d = new Date(s); 
        if (!isNaN(d.getTime())) return format12(d.getHours(), d.getMinutes()); 
      }
      
      var m = s.replace(/\./g, '').replace(/\s+/g, ' ')
               .match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)?$/i);
      if (m){ 
        var h = parseInt(m[1], 10);
        var mins = parseInt(m[2] || '0', 10);
        var ap = m[3] ? m[3].toUpperCase() : null; 
        if (ap){ 
          if (ap === 'PM' && h < 12) h += 12; 
          if (ap === 'AM' && h === 12) h = 0; 
        } 
        return format12(h, mins); 
      }
      
      return s;
    }
    
    function parseTimeToDate(t){
      if (!t) return null; 
      var s = String(t).trim();
      
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)){ 
        var d = new Date(s); 
        return isNaN(d.getTime()) ? null : d; 
      }
      
      var m = s.replace(/\./g, '').replace(/\s+/g, ' ')
               .match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)?$/i);
      if (m){ 
        var now = new Date(); 
        var h = parseInt(m[1], 10);
        var mins = parseInt(m[2] || '0', 10);
        var ap = m[3] ? m[3].toUpperCase() : null; 
        if (ap){ 
          if (ap === 'PM' && h < 12) h += 12; 
          if (ap === 'AM' && h === 12) h = 0; 
        } 
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mins, 0, 0); 
      }
      
      var parts = s.split(/\s*[-\u2013\u2014]\s*/); 
      if (parts.length === 2) return parseTimeToDate(parts[0]);
      
      return null;
    }
    
    function parseDateAndTime(dateRaw, timeRaw){
      var dateMatch = String(dateRaw || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      var timeText = String(timeRaw || '').trim().replace(/\./g, '').replace(/\s+/g, ' ');
      var timeMatch = timeText.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)?$/i);
      if (!dateMatch || !timeMatch) return parseTimeToDate(timeRaw);

      var hour = parseInt(timeMatch[1], 10);
      var minute = parseInt(timeMatch[2] || '0', 10);
      var ap = timeMatch[3] ? timeMatch[3].toUpperCase() : null;
      if (ap === 'PM' && hour < 12) hour += 12;
      if (ap === 'AM' && hour === 12) hour = 0;

      return new Date(
        parseInt(dateMatch[1], 10),
        parseInt(dateMatch[2], 10) - 1,
        parseInt(dateMatch[3], 10),
        hour,
        minute,
        0,
        0
      );
    }

    function getEventTimes(ev){
      var sRaw = ev && (ev.start_time || ev.startTime || ev.start || 
                 (ev.time && String(ev.time).split(/\s*[-\u2013\u2014]\s*/)[0]));
      var eRaw = ev && (ev.end_time || ev.endTime || ev.end || 
                 (ev.time && String(ev.time).split(/\s*[-\u2013\u2014]\s*/)[1]));
      var startDateRaw = ev && (ev.date || ev.start_date || ev.startDate);
      var endDateRaw = ev && (ev.end_date || ev.endDate || startDateRaw);
      
      var start = startDateRaw ? parseDateAndTime(startDateRaw, sRaw) : parseTimeToDate(sRaw);
      var end = endDateRaw ? parseDateAndTime(endDateRaw, eRaw) : parseTimeToDate(eRaw);
      
      if (start && !end){ 
        end = new Date(start.getTime() + CONFIG.DEFAULT_EVENT_DURATION * 60 * 1000); 
      }
      
      if (start && end && end.getTime() <= start.getTime()){ 
        end = new Date(end.getTime() + 24 * 60 * 60 * 1000); 
      }
      
      return {start: start, end: end};
    }

    var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    
    function fmtClock(d){ 
      var dow = DAYS[d.getDay()];
      var mon = MONTHS[d.getMonth()];
      var day = d.getDate();
      var h = d.getHours();
      var m = pad2(d.getMinutes()); 
      
      if (CONFIG.FORCE_12H_CLOCK){ 
        var ap = h >= 12 ? 'PM' : 'AM'; 
        var hh = h % 12; 
        if (hh === 0) hh = 12; 
        return dow + ', ' + mon + ' ' + day + ' \u00B7 ' + hh + ':' + m + ' ' + ap; 
      } 
      
      return dow + ', ' + mon + ' ' + day + ' \u00B7 ' + pad2(h) + ':' + m; 
    }
    
    function updateClock(){
      var now = new Date();
      var s = fmtClock(now);
      var el1 = document.getElementById('clock');
      if (el1) el1.textContent = s;
      var el2 = document.getElementById('empty-clock');
      if (el2) el2.textContent = s;
      var el3 = document.getElementById('combined-clock');
      if (el3) el3.textContent = s;
    }
    
    function buildApiUrl(){ 
      return apiBase() + '?id=' + 
             encodeURIComponent(state.screenCode); 
    }
    
    function xhrGetWithRetry(url, ok, fail){
      var t0 = Date.now();
      
      function attempt() {
        try{
          var x = new XMLHttpRequest();
          x.open('GET', url, true);
          
          x.onreadystatechange = function(){
            if (x.readyState === 4){
              var dt = Date.now() - t0;
              
              if (x.status >= 200 && x.status < 300){ 
                updateNetworkStatus('success', dt); 
                state.retryCount = 0;
                ok && ok(x.responseText); 
              } else { 
                handleError(new Error('HTTP ' + x.status));
              }
            }
          };
          
          x.timeout = CONFIG.API_TIMEOUT;
          x.ontimeout = function(){ 
            handleError(new Error('timeout')); 
          };
          
          x.send(null);
        } catch(e){ 
          handleError(e);
        }
      }
      
      function handleError(e) {
        updateNetworkStatus('error');
        
        if (state.retryCount < CONFIG.RETRY_DELAYS.length) {
          var delay = CONFIG.RETRY_DELAYS[state.retryCount];
          state.retryCount++;
          setTimeout(attempt, delay);
        } else {
          reportPlayerError('network', e && e.message ? e.message : String(e), { url: url });
          fail && fail(e);
        }
      }
      
      attempt();
    }


    function postJson(url, payload, done){
      try {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'application/json');
        x.timeout = CONFIG.API_TIMEOUT;
        x.onload = function(){
          var body = null;
          try { body = x.responseText ? JSON.parse(x.responseText) : null; } catch(e){}
          if (done) done(x.status >= 200 && x.status < 300, body, x.status);
        };
        x.onerror = function(){ if (done) done(false, null, 0); };
        x.ontimeout = function(){ if (done) done(false, null, 0); };
        x.send(JSON.stringify(payload || {}));
      } catch(e){ if (done) done(false, null, 0); }
    }

    function bridgeValue(bridge, name){
      try {
        if (bridge && typeof bridge[name] === 'function') return bridge[name]();
      } catch(e){}
      return '';
    }

    function platformDetails(){
      var ua = navigator.userAgent || '';
      var lower = ua.toLowerCase();
      var platform = 'browser';
      var osName = 'Unknown';
      var osVersion = '';
      var browserName = 'Browser';
      var browserVersion = '';
      if (window.AndroidBridge || window.PostSignageNative || hasNativePlayer()) platform = 'android_app';
      else if (lower.indexOf('webos') !== -1 || lower.indexOf('netcast') !== -1 || window.PalmServiceBridge) platform = 'lg_si';
      else if (lower.indexOf('tizen') !== -1 || window.tizen) platform = 'tizen';
      else if (lower.indexOf('android') !== -1) platform = 'android_browser';

      var m;
      if ((m = ua.match(/Web0S[\/ ]([\d.]+)/i)) || (m = ua.match(/webOS[\/ ]([\d.]+)/i))) { osName = 'webOS'; osVersion = m[1] || ''; }
      else if ((m = ua.match(/Android[\/ ]([\d.]+)/i))) { osName = 'Android'; osVersion = m[1] || ''; }
      else if ((m = ua.match(/Windows NT[\/ ]([\d.]+)/i))) { osName = 'Windows'; osVersion = m[1] || ''; }
      else if ((m = ua.match(/Tizen[\/ ]([\d.]+)/i))) { osName = 'Tizen'; osVersion = m[1] || ''; }

      if ((m = ua.match(/Chrome[\/ ]([\d.]+)/i))) { browserName = 'Chrome'; browserVersion = m[1] || ''; }
      else if ((m = ua.match(/Version[\/ ]([\d.]+)/i))) { browserName = platform === 'lg_si' ? 'LG Browser' : 'WebKit'; browserVersion = m[1] || ''; }
      else if ((m = ua.match(/AppleWebKit[\/ ]([\d.]+)/i))) { browserName = 'WebKit'; browserVersion = m[1] || ''; }

      var model = bridgeValue(window.PostSignageNative, 'getDeviceModel') || bridgeValue(window.AndroidBridge, 'getDeviceModel') || bridgeValue(window.NativePlayer, 'getDeviceModel');
      if (!model && platform === 'lg_si') {
        m = ua.match(/(?:model|LGTV)[\/\s:;-]*([A-Za-z0-9._-]+)/i);
        model = m ? m[1] : 'LG commercial display';
      }
      if (!model) model = navigator.platform || 'Unknown device';

      return { platform: platform, model: String(model), os_name: osName, os_version: osVersion, browser_name: browserName, browser_version: browserVersion };
    }

    function networkDetails(){
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
      var rtt = Number(c.rtt || net.responseTime || 0);
      var quality = 'unknown';
      if (navigator.onLine === false) quality = 'offline';
      else if (rtt && rtt < 300) quality = 'good';
      else if (rtt && rtt < 1200) quality = 'fair';
      else if (rtt) quality = 'poor';
      return {
        network_type: c.effectiveType || c.type || '',
        network_downlink_mbps: Number(c.downlink || 0),
        network_rtt_ms: Math.round(rtt || 0),
        network_quality: quality
      };
    }

    function parseNativeCapabilities(value){
      if (!value) return null;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch(e){ return null; }
      }
      return value && typeof value === 'object' ? value : null;
    }

    function nativeBridgeCandidates(){
      var list = [];
      function add(value){
        if (!value) return;
        for (var i=0; i<list.length; i++) if (list[i] === value) return;
        list.push(value);
      }
      try { add(window.PostSignageNative); } catch(e){}
      try { add(window.AndroidBridge); } catch(e){}
      try { add(window.NativePlayer); } catch(e){}
      return list;
    }

    function callBridgeMethod(bridge, name){
      if (!bridge) return { called:false, value:null };
      try {
        // Android WebView JavascriptInterface methods are not reported as
        // normal JavaScript functions on every WebView release. Attempt the
        // method directly rather than relying only on typeof.
        if (bridge[name] !== undefined && bridge[name] !== null) {
          return { called:true, value:bridge[name]() };
        }
      } catch(e){
        return { called:true, error:e, value:null };
      }
      return { called:false, value:null };
    }

    function nativeCapabilities(){
      var caps = null;
      try { caps = parseNativeCapabilities(window.__POSTSIGNAGE_NATIVE__); } catch(e){}
      if (!caps) {
        try { caps = parseNativeCapabilities(window.postSignageNativeCapabilities); } catch(e){}
      }

      var bridges = nativeBridgeCandidates();
      for (var i=0; !caps && i<bridges.length; i++) {
        var result = callBridgeMethod(bridges[i], 'getCapabilitiesJson');
        if (!result.called) result = callBridgeMethod(bridges[i], 'getCapabilities');
        caps = parseNativeCapabilities(result.value);
      }

      if (!caps) caps = {};
      if (caps.screenshot_native !== true) {
        for (var j=0; j<bridges.length; j++) {
          var supported = callBridgeMethod(bridges[j], 'isNativeScreenshotSupported');
          if (!supported.called) supported = callBridgeMethod(bridges[j], 'screenshotNative');
          if (supported.called && (supported.value === true || String(supported.value).toLowerCase() === 'true')) {
            caps.screenshot_native = true;
            break;
          }
        }
      }

      if (caps.screenshot_native !== true) {
        for (var k=0; k<bridges.length; k++) {
          var b = bridges[k];
          try {
            if (b && (
              b.captureScreenDataUrl !== undefined ||
              b.captureScreenBase64 !== undefined ||
              b.captureScreen !== undefined
            )) {
              caps.screenshot_native = true;
              break;
            }
          } catch(e){}
        }
      }
      return caps;
    }

    function deviceCapabilities(){
      var caps = nativeCapabilities();
      var bridges = nativeBridgeCandidates();
      var restart = false;
      for (var i=0; i<bridges.length; i++) {
        try {
          if (bridges[i] && bridges[i].restartApp !== undefined) { restart = true; break; }
        } catch(e){}
      }
      return {
        reload: true,
        restart_app: restart,
        screenshot_native: caps.screenshot_native === true,
        screenshot_method: caps.screenshot_method || '',
        native_app_version: caps.app_version || '',
        native_bridge_version: caps.bridge_version || '',
        screenshot_dom: typeof window.html2canvas === 'function'
      };
    }

    function devicePayload(){
      var pd = platformDetails();
      var nd = networkDetails();
      return {
        platform: pd.platform,
        model: pd.model,
        screen_width: window.screen ? window.screen.width : window.innerWidth,
        screen_height: window.screen ? window.screen.height : window.innerHeight,
        orientation: window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait',
        player_version: PLAYER_VERSION,
        player_updated_at: PLAYER_UPDATED_AT,
        browser_name: pd.browser_name,
        browser_version: pd.browser_version,
        os_name: pd.os_name,
        os_version: pd.os_version,
        user_agent: navigator.userAgent || '',
        network_type: nd.network_type,
        network_downlink_mbps: nd.network_downlink_mbps,
        network_rtt_ms: nd.network_rtt_ms,
        network_quality: nd.network_quality,
        capabilities: deviceCapabilities(),
        screenshot_native: deviceCapabilities().screenshot_native,
        screenshot_method: deviceCapabilities().screenshot_method || '',
        native_app_version: deviceCapabilities().native_app_version || '',
        last_content_sync_at: deviceState.lastContentSyncAt,
        last_ad_campaign_id: deviceState.lastAdCampaignId,
        last_ad_name: deviceState.lastAdName
      };
    }

    function sendDeviceStatus(){
      if (!state.screenCode || isPreviewMode()) return;
      postJson(buildApiUrl() + '&device=1', devicePayload(), function(ok, body, status){
        if (!ok) console.log('[device-status] failed', status, body || '');
      });
    }

    function reportPlayerError(errorType, message, context){
      var now = Date.now();
      var key = String(errorType || 'runtime');
      if (now - (deviceState.lastErrorByType[key] || 0) < 60000) return;
      deviceState.lastErrorByType[key] = now;
      postJson(buildApiUrl() + '&player_error=1', {
        error_type: key,
        message: String(message || 'Unknown player error').slice(0, 2000),
        context: context || {},
        player_version: PLAYER_VERSION
      });
    }

    function ackCommand(commandId, status, result, errorMessage, done){
      postJson(buildApiUrl() + '&command_ack=1', {
        command_id: commandId,
        status: status,
        result: result || {},
        error_message: errorMessage || null
      }, done);
    }

    function dataUrlFromNative(value){
      if (!value || typeof value !== 'string') return null;
      return value.indexOf('data:image/') === 0 ? value : 'data:image/jpeg;base64,' + value;
    }

    function captureNativeScreenshot(){
      return new Promise(function(resolve, reject){
        var bridges = nativeBridgeCandidates();
        var methods = ['captureScreenDataUrl', 'captureScreenBase64', 'captureScreen'];
        var finished = false;

        function succeed(value){
          if (finished) return true;
          var dataUrl = dataUrlFromNative(value);
          if (!dataUrl) return false;
          finished = true;
          var caps = nativeCapabilities();
          resolve({
            dataUrl: dataUrl,
            type: 'native',
            native_method: caps.screenshot_method || 'pixelcopy_window'
          });
          return true;
        }

        function tryCapture(attempt){
          var lastError = null;
          for (var i=0; i<bridges.length; i++) {
            for (var j=0; j<methods.length; j++) {
              var result = callBridgeMethod(bridges[i], methods[j]);
              if (!result.called) continue;
              if (result.error) {
                lastError = result.error;
                continue;
              }
              var value = result.value;
              if (value && typeof value.then === 'function') {
                value.then(function(v){
                  if (!succeed(v) && !finished) reject(new Error('Native capture returned no image'));
                }).catch(function(error){ if (!finished) reject(error); });
                return;
              }
              if (succeed(value)) return;
            }
          }

          // MainActivity injects native capability metadata after page load.
          // A command can arrive during that brief window, so retry once.
          if (attempt < 1) {
            setTimeout(function(){
              bridges = nativeBridgeCandidates();
              tryCapture(attempt + 1);
            }, 350);
            return;
          }
          reject(lastError || new Error('PixelCopy bridge returned no image'));
        }

        tryCapture(0);
      });
    }

    function mediaProxyUrl(url){
      if (!url) return '';
      var base = apiBase();
      if (String(url).indexOf(base + '?media_proxy=1') === 0) return String(url);
      return base + '?media_proxy=1&src=' + encodeURIComponent(String(url));
    }

    function mediaUrlAllowsCors(url){
      try {
        var parsed = new URL(url, window.location.href);
        return parsed.origin === window.location.origin
          || parsed.hostname.indexOf('.workers.dev') !== -1
          || parsed.hostname.indexOf('.supabase.co') !== -1
          || parsed.hostname.indexOf('.supabase.in') !== -1;
      } catch(e){ return false; }
    }

    function loadImageForCapture(url){
      return new Promise(function(resolve, reject){
        if (!url) return reject(new Error('No ad image URL'));
        var img = new Image();
        if (mediaUrlAllowsCors(url)) img.crossOrigin = 'anonymous';
        img.onload = function(){ resolve(img); };
        img.onerror = function(){ reject(new Error('Unable to load ad image for screenshot')); };
        img.src = mediaProxyUrl(url);
      });
    }

    function drawCover(ctx, source, dx, dy, dw, dh){
      var sw = source.videoWidth || source.naturalWidth || source.width || 0;
      var sh = source.videoHeight || source.naturalHeight || source.height || 0;
      if (!sw || !sh || !dw || !dh) return;
      var scale = Math.max(dw / sw, dh / sh);
      var cropW = dw / scale;
      var cropH = dh / scale;
      var sx = Math.max(0, (sw - cropW) / 2);
      var sy = Math.max(0, (sh - cropH) / 2);
      ctx.drawImage(source, sx, sy, cropW, cropH, dx, dy, dw, dh);
    }


    function drawProofFallback(ctx, dx, dy, dw, dh){
      try {
        var ad = adAt(0);
        var name = ad && ad.name ? String(ad.name).replace(/_/g, ' ') : 'Advertisement';
        ctx.save();
        ctx.fillStyle = '#101010';
        ctx.fillRect(dx, dy, dw, dh);
        ctx.strokeStyle = '#2b2b2b';
        ctx.lineWidth = Math.max(2, Math.round(dw * 0.008));
        ctx.strokeRect(dx + 2, dy + 2, Math.max(0, dw - 4), Math.max(0, dh - 4));
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '700 ' + Math.max(18, Math.round(dw * 0.065)) + 'px Arial, sans-serif';
        ctx.fillText(name.slice(0, 42), dx + dw / 2, dy + dh / 2 - Math.max(10, dh * 0.035), Math.max(20, dw * 0.86));
        ctx.fillStyle = '#b8b8b8';
        ctx.font = '600 ' + Math.max(12, Math.round(dw * 0.035)) + 'px Arial, sans-serif';
        ctx.fillText('PROOF OF PLAY · ' + new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}), dx + dw / 2, dy + dh / 2 + Math.max(18, dh * 0.04), Math.max(20, dw * 0.9));
        ctx.restore();
      } catch(e){}
    }

    function currentAdForCapture(){
      try { return adAt(0); } catch(e){ return null; }
    }

    /* Native Android video is rendered by ExoPlayer above the WebView and is
       therefore invisible to html2canvas. For screenshot proof, decode one
       software frame through a temporary WebView <video>. This does not alter
       the ad that is playing on the TV. */
    function captureVideoFrameForScreenshot(url){
      return new Promise(function(resolve, reject){
        if (!url) return reject(new Error('No video URL'));
        var video = document.createElement('video');
        var finished = false;
        var timer = null;
        function cleanup(){
          if (timer) clearTimeout(timer);
          try { video.pause(); } catch(e){}
          try { video.removeAttribute('src'); video.load(); } catch(e){}
          if (video.parentNode) video.parentNode.removeChild(video);
        }
        function fail(message){
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error(message || 'Unable to decode video frame'));
        }
        function grab(){
          if (finished || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
          try {
            var maxW = 960;
            var scale = Math.min(1, maxW / video.videoWidth);
            var frame = document.createElement('canvas');
            frame.width = Math.max(2, Math.round(video.videoWidth * scale));
            frame.height = Math.max(2, Math.round(video.videoHeight * scale));
            var frameCtx = frame.getContext('2d');
            frameCtx.drawImage(video, 0, 0, frame.width, frame.height);
            finished = true;
            cleanup();
            resolve(frame);
            return true;
          } catch(e){ return false; }
        }
        function seekOrGrab(){
          if (finished) return;
          var target = 0;
          if (isFinite(video.duration) && video.duration > 0.5) target = Math.min(1, Math.max(0.15, video.duration * 0.08));
          if (target > 0 && Math.abs((video.currentTime || 0) - target) > 0.05) {
            try { video.currentTime = target; return; } catch(e){}
          }
          setTimeout(function(){ if (!grab()) fail('Video frame was not available'); }, 120);
        }
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';
        video.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:32px;height:32px;opacity:0.001;pointer-events:none;';
        video.addEventListener('loadeddata', seekOrGrab);
        video.addEventListener('seeked', function(){ setTimeout(function(){ if (!grab()) fail('Unable to copy decoded video frame'); }, 80); });
        video.addEventListener('error', function(){ fail('WebView could not decode this video for screenshot'); });
        document.body.appendChild(video);
        video.src = mediaProxyUrl(url);
        try { video.load(); } catch(e){}
        try {
          var playPromise = video.play();
          if (playPromise && playPromise.catch) playPromise.catch(function(){});
        } catch(e){}
        timer = setTimeout(function(){ if (!grab()) fail('Timed out decoding video frame'); }, 6500);
      });
    }

    function compositeAdIntoScreenshot(canvas){
      return new Promise(function(resolve){
        try {
          if (!document.body.classList.contains('ads-active')) return resolve(canvas);
          var column = document.getElementById('ad-column');
          if (!column) return resolve(canvas);
          var rect = column.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return resolve(canvas);

          var scaleX = canvas.width / Math.max(window.innerWidth, 1);
          var scaleY = canvas.height / Math.max(window.innerHeight, 1);
          var dx = Math.round(rect.left * scaleX);
          var dy = Math.round(rect.top * scaleY);
          var dw = Math.round(rect.width * scaleX);
          var dh = Math.round(rect.height * scaleY);
          var ctx = canvas.getContext('2d');
          if (!ctx) return resolve(canvas);

          var imageEl = document.getElementById('ad-image');
          var imageVisible = imageEl && imageEl.style.display !== 'none' && (imageEl.currentSrc || imageEl.src);
          if (imageVisible) {
            loadImageForCapture(imageEl.currentSrc || imageEl.src).then(function(img){
              try { drawCover(ctx, img, dx, dy, dw, dh); } catch(e){}
              resolve(canvas);
            }).catch(function(){ drawProofFallback(ctx, dx, dy, dw, dh); resolve(canvas); });
            return;
          }

          var activeVideo = document.querySelector('#ad-column video.showing');
          if (activeVideo && activeVideo.readyState >= 2 && activeVideo.videoWidth) {
            try { drawCover(ctx, activeVideo, dx, dy, dw, dh); return resolve(canvas); } catch(e){}
          }

          var currentAd = currentAdForCapture();
          if (currentAd && currentAd.media_type !== 'image' && currentAd.media_url) {
            captureVideoFrameForScreenshot(currentAd.media_url).then(function(frame){
              try { drawCover(ctx, frame, dx, dy, dw, dh); } catch(e){ drawProofFallback(ctx, dx, dy, dw, dh); }
              resolve(canvas);
            }).catch(function(){ drawProofFallback(ctx, dx, dy, dw, dh); resolve(canvas); });
            return;
          }

          drawProofFallback(ctx, dx, dy, dw, dh);
          resolve(canvas);
        } catch(e){ resolve(canvas); }
      });
    }

    function captureDomScreenshot(){
      return new Promise(function(resolve, reject){
        if (typeof window.html2canvas !== 'function') return reject(new Error('DOM screenshot library did not load'));
        var viewportWidth = Math.max(window.innerWidth || document.documentElement.clientWidth || 1, 1);
        var viewportHeight = Math.max(window.innerHeight || document.documentElement.clientHeight || 1, 1);
        var liveAdColumn = document.getElementById('ad-column');
        if (liveAdColumn) liveAdColumn.setAttribute('data-html2canvas-ignore', 'true');

        function restoreAdColumn(){
          if (liveAdColumn) liveAdColumn.removeAttribute('data-html2canvas-ignore');
        }

        window.html2canvas(document.body, {
          backgroundColor: '#000000',
          logging: false,
          useCORS: true,
          allowTaint: false,
          x: 0,
          y: 0,
          scrollX: 0,
          scrollY: 0,
          width: viewportWidth,
          height: viewportHeight,
          windowWidth: viewportWidth,
          windowHeight: viewportHeight,
          scale: Math.min(1, 1280 / viewportWidth),
          ignoreElements: function(element){
            var node = element;
            while (node) {
              if (node.id === 'ad-column') return true;
              node = node.parentNode;
            }
            return false;
          }
        }).then(function(canvas){
          restoreAdColumn();
          return compositeAdIntoScreenshot(canvas);
        }).then(function(canvas){
          resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.72), type: 'dom', width: canvas.width, height: canvas.height });
        }).catch(function(error){
          restoreAdColumn();
          reject(error);
        });
      });
    }

    function uploadScreenshot(command, shot){
      postJson(buildApiUrl() + '&screenshot=1', {
        command_id: command.id,
        image_base64: shot.dataUrl,
        capture_type: shot.type || 'dom',
        width: shot.width || window.innerWidth,
        height: shot.height || window.innerHeight
      }, function(ok, body){
        deviceState.commandBusy = false;
        if (!ok) {
          var reason = body && body.reason ? body.reason : 'Screenshot upload failed';
          ackCommand(command.id, 'failed', {}, reason);
          reportPlayerError('screenshot', reason, { command_id: command.id });
        }
      });
    }

    function executeRemoteCommand(command){
      if (!command || !command.id || deviceState.commandBusy) return;
      deviceState.commandBusy = true;
      if (command.type === 'reload') {
        ackCommand(command.id, 'completed', { action: 'reload' }, null, function(){
          setTimeout(function(){
            try {
              hardReloadPlayer();
            } catch(e){ window.location.reload(); }
          }, 400);
        });
        return;
      }
      if (command.type === 'restart_app') {
        try {
          var supported = false;
          if (window.AndroidBridge && typeof window.AndroidBridge.restartApp === 'function') { supported = true; window.AndroidBridge.restartApp(); }
          else if (window.NativePlayer && typeof window.NativePlayer.restartApp === 'function') { supported = true; window.NativePlayer.restartApp(); }
          if (!supported) throw new Error('App restart is not supported on this player');
          ackCommand(command.id, 'completed', { action: 'restart_app' });
        } catch(e){
          deviceState.commandBusy = false;
          ackCommand(command.id, 'failed', {}, e.message || String(e));
        }
        return;
      }
      if (command.type === 'screenshot') {
        var nativeCapable = deviceCapabilities().screenshot_native;
        var capture = nativeCapable ? captureNativeScreenshot().catch(function(){ return captureDomScreenshot(); }) : captureDomScreenshot();
        capture.then(function(shot){ uploadScreenshot(command, shot); }).catch(function(e){
          deviceState.commandBusy = false;
          ackCommand(command.id, 'failed', {}, e.message || String(e));
          reportPlayerError('screenshot', e.message || String(e), { command_id: command.id });
        });
        return;
      }
      deviceState.commandBusy = false;
      ackCommand(command.id, 'failed', {}, 'Unsupported command');
    }

    function pollRemoteCommand(){
      if (!state.screenCode || deviceState.commandBusy || isPreviewMode()) return;
      try {
        var x = new XMLHttpRequest();
        var commandUrl = buildApiUrl() + '&command=1&_=' + Date.now();
        x.open('GET', commandUrl, true);
        x.timeout = 5000;
        x.onload = function(){
          if (x.status < 200 || x.status >= 300) {
            console.log('[remote-command] pull failed', x.status, x.responseText || '');
            return;
          }
          try {
            var body = JSON.parse(x.responseText || '{}');
            if (body.command) {
              console.log('[remote-command] received', body.command.type, body.command.id);
              executeRemoteCommand(body.command);
            }
          } catch(e){ console.log('[remote-command] invalid response', e); }
        };
        x.onerror = function(){ console.log('[remote-command] network error'); };
        x.ontimeout = function(){ console.log('[remote-command] timeout'); };
        x.send(null);
      } catch(e){ console.log('[remote-command] exception', e); }
    }

    function compactPlayerVersion(version){
      return String(version || '').replace(/\D/g, '') || '0';
    }

    function hardReloadPlayer(){
      try {
        var nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('v', compactPlayerVersion(PLAYER_VERSION));
        nextUrl.searchParams.set('_reload', String(Date.now()));
        var target = nextUrl.toString();

        try {
          if (window.AndroidBridge && typeof window.AndroidBridge.clearWebViewCache === 'function') {
            window.AndroidBridge.clearWebViewCache();
          }
        } catch(e){}

        if (window.AndroidBridge && typeof window.AndroidBridge.loadUrl === 'function') {
          window.AndroidBridge.loadUrl(target);
        } else {
          window.location.replace(target);
        }
      } catch(e){
        window.location.reload();
      }
    }

    function checkForPlayerUpdate(){
      try {
        var updateUrl = new URL('./version.json', window.location.href);
        updateUrl.searchParams.set('_', String(Date.now()));
        fetch(updateUrl.toString(), { cache:'no-store' })
          .then(function(response){ return response.ok ? response.json() : null; })
          .then(function(info){
            if (!info || !info.version) return;
            if (String(info.version) !== String(PLAYER_VERSION)) hardReloadPlayer();
          })
          .catch(function(){});
      } catch(e){}
    }

    window.addEventListener('postsignage:native-ready', function(event){
      try {
        console.log('[native-bridge] ready', event && event.detail ? event.detail : '');
        sendDeviceStatus();
        pollRemoteCommand();
      } catch(e){}
    });

    window.addEventListener('error', function(event){
      reportPlayerError('javascript', event.message || 'JavaScript error', { file: event.filename || '', line: event.lineno || 0, column: event.colno || 0 });
    });
    window.addEventListener('unhandledrejection', function(event){
      var reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || 'Unhandled promise rejection');
      reportPlayerError('promise', reason, {});
    });

    var TICKER = {text: '', x: 0, w: 0, holderW: 0, emptyStreak: 0, lastTime: 0, animFrame: null};
    
    function normalizeText(t){ 
      return String(t || '').replace(/\s+/g, ' ').trim(); 
    }
    
    function measureTicker(){ 
      var holder = document.getElementById('ticker');
      var track = document.getElementById('ticker-track'); 
      if (!holder || !track) return; 
      
      TICKER.holderW = holder.clientWidth || 1920; 
      var original = track.textContent; 
      
      if (TICKER.text && original !== TICKER.text) track.textContent = TICKER.text; 
      
      var rect = track.getBoundingClientRect(); 
      TICKER.w = rect.width || track.scrollWidth || track.offsetWidth || (TICKER.text.length * 12); 
    }
    
    function applyTicker(){
      var holder = document.getElementById('ticker');
      var track = document.getElementById('ticker-track');
      if (!holder || !track) return;

      if (!TICKER.text){
        holder.classList.remove('active');
        stopCssTicker();
        return;
      }

      holder.classList.add('active');
      track.textContent = TICKER.text;
      measureTicker(); 
      startCssTicker(track);
    }

    // CSS-animated scroll: runs on the GPU compositor, so it stays smooth
    // even while the panel's CPU is busy decoding ad video.
    function startCssTicker(track){
      var startX = Math.round(TICKER.holderW || 1920);
      var endX = -Math.round(TICKER.w || 1000);
      var dur = (startX - endX) / (CONFIG.TICKER_SPEED || 100); // px / (px per s)
      var styleEl = document.getElementById('ticker-keyframes');
      if (!styleEl){
        styleEl = document.createElement('style');
        styleEl.id = 'ticker-keyframes';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = '@keyframes asgTicker{from{transform:translate3d(' + startX +
        'px,0,0)}to{transform:translate3d(' + endX + 'px,0,0)}}';
      track.style.transform = '';
      track.style.animation = 'none';
      void track.offsetWidth; // reflow so the animation restarts with new keyframes
      track.style.animation = 'asgTicker ' + dur.toFixed(2) + 's linear infinite';
    }

    function stopCssTicker(){
      var track = document.getElementById('ticker-track');
      if (track) track.style.animation = 'none';
    }
    
    function updateTickerText(newText){ 
      var norm = normalizeText(newText); 
      
      if (!norm){ 
        if (TICKER.text){ 
          TICKER.emptyStreak++; 
          if (TICKER.emptyStreak <= 1) return; 
        } 
        TICKER.text = ''; 
        TICKER.emptyStreak = 0; 
        applyTicker(); 
        return; 
      } 
      
      TICKER.emptyStreak = 0; 
      if (norm === TICKER.text) return; 
      
      TICKER.text = norm; 
      applyTicker(); 
    }
    
    function animationLoop(){ /* retired: ticker now runs as a CSS animation (startCssTicker) */ }
    
    window.addEventListener('resize', function(){
      measureTicker();
      var t = document.getElementById('ticker-track');
      if (t && TICKER.text) startCssTicker(t);
    });

    // ---- Orientation handling (portrait / landscape, e.g. LG rotated screens) ----
    function applyOrientation(){
      var portrait = (window.innerHeight > window.innerWidth);
      if (document.body){
        document.body.classList.toggle('portrait', portrait);
        document.body.classList.toggle('landscape', !portrait);
      }
      if (state.combinedLayout && state.combinedRinks && state.combinedRinks.length){
        updateCombinedDisplay();
      }
      try { measureTicker(); } catch(e){}
    }
    window.addEventListener('orientationchange', function(){ setTimeout(applyOrientation, 150); });
    window.addEventListener('resize', applyOrientation);

    // ================= TOMORROW PREVIEW (after 9pm) =================
    // After 21:00 screen-local time, if tomorrow has bookings, alternate:
    // 20s today's board / 10s tomorrow's board. Off during the day.
    var TMR = { events: [], date: '', timer: null, showing: false };

    function fmtTomorrowTitle(dateStr){
      try {
        var d = new Date(dateStr + 'T12:00:00');
        var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        var mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return 'Tomorrow \u2014 ' + days[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate();
      } catch(e){ return 'Tomorrow'; }
    }

    function renderTomorrow(){
      var el = document.getElementById('tomorrow-overlay');
      if (!el) return;
      var html = '<div class="tm-title">' + fmtTomorrowTitle(TMR.date) + '</div>';
      for (var i = 0; i < TMR.events.length && i < 12; i++){
        var ev = TMR.events[i];
        var t = (ev.start_time || '') + (ev.end_time ? ' - ' + ev.end_time : '');
        html += '<div class="tm-row">'
             +  '<div class="tm-time">' + t + '</div>'
             +  '<div class="tm-event">' + String(ev.teams || '').replace(/</g,'&lt;') + '</div>'
             +  '<div class="tm-room">' + String(ev.room || '').replace(/</g,'&lt;') + '</div>'
             +  '</div>';
      }
      el.innerHTML = html;
    }

    function updateTomorrow(data){
      TMR.events = (data && data.events_tomorrow) || [];
      TMR.date = (data && data.tomorrow_date_local) || '';
      var isEvening = false; // tomorrow-preview disabled per owner
      var shouldCycle = isEvening && TMR.events.length > 0 && !state.combinedLayout;
      function tmrTick(){
        TMR.showing = !TMR.showing;
        if (TMR.showing) renderTomorrow();
        if (document.body) document.body.classList.toggle('show-tomorrow', TMR.showing);
        clearTimeout(TMR.timer);
        TMR.timer = setTimeout(tmrTick, TMR.showing ? 10000 : 20000); // 10s tomorrow, 20s today
      }
      if (shouldCycle && !TMR.timer){
        TMR.timer = setTimeout(tmrTick, 20000);
      } else if (!shouldCycle && TMR.timer){
        clearTimeout(TMR.timer); TMR.timer = null; TMR.showing = false;
        if (document.body) document.body.classList.remove('show-tomorrow');
      }
    }

    // ================= AD CAMPAIGN PLAYLIST (double-buffered) =================
    // Two stacked <video> elements: the next ad preloads in the hidden one
    // while the current plays; we crossfade on the 'playing' event so the
    // WebView's grey play-button overlay is never visible between ads.
    var ADS = { list: [], idx: 0, sig: '', imgTimer: null, active: null, swapping: false };

    // Native ExoPlayer bridge (ArenaSignage Android player). Hardware-decoded
    // video + disk cache. Falls back to <video> double-buffering elsewhere.
    function hasNativePlayer(){
      try { return !!(window.NativePlayer && window.NativePlayer.isAvailable()); }
      catch(e){ return false; }
    }

    function adColumnRect(){
      var el = document.getElementById('ad-column');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }

    function nativePlayCurrent(ad){
      var r = adColumnRect();
      if (!r || r.w < 2 || r.h < 2){ setTimeout(function(){ playCurrentAd(); }, 300); return; }
      try {
        window.NativePlayer.play(String(ad.id), ad.media_url, r.x, r.y, r.w, r.h, ADS.list.length === 1);
        var nxt = adAt(1);
        if (nxt && nxt.media_type !== 'image' && nxt.media_url !== ad.media_url){
          window.NativePlayer.preload(nxt.media_url);
        }
      } catch(e){ setTimeout(nextAd, 3000); }
    }

    // Events from the native player
    window.__nativePlayerEvent = function(id, ev){
      if (!ADS.list.length) return;
      if (ev === 'ended'){
        var ad = adAt(0);
        if (ad) reportPlay(ad.id);
        nextAd();
      } else if (ev === 'looped'){
        var ad2 = adAt(0);
        if (ad2) reportPlay(ad2.id);   // proof-of-play per loop of a single-ad rotation
      } else if (ev === 'error'){
        setTimeout(nextAd, 3000);      // skip broken file
      }
    };

    // Keep the native surface aligned with the ad column on rotation/resize
    (function(){
      var t = null;
      function sync(){
        if (!hasNativePlayer() || !ADS.list.length) return;
        var r = adColumnRect();
        if (r) try { window.NativePlayer.setRect(r.x, r.y, r.w, r.h); } catch(e){}
      }
      window.addEventListener('resize', function(){ clearTimeout(t); t = setTimeout(sync, 250); });
      window.addEventListener('orientationchange', function(){ clearTimeout(t); t = setTimeout(sync, 400); });
    })();

    function adEls(){
      return {
        a: document.getElementById('ad-video-a'),
        b: document.getElementById('ad-video-b'),
        img: document.getElementById('ad-image')
      };
    }

    function adsSignature(list){
      var out = [];
      for (var i = 0; i < list.length; i++) out.push(list[i].id + '@' + list[i].media_url + '@' + list[i].weight);
      return out.join('|');
    }

    // weight expansion: weight 2 => appears twice per rotation, interleaved
    function buildRotation(list){
      var rot = [], maxW = 1, i;
      for (i = 0; i < list.length; i++) maxW = Math.max(maxW, Number(list[i].weight) || 1);
      for (var pass = 0; pass < maxW; pass++){
        for (i = 0; i < list.length; i++){
          if ((Number(list[i].weight) || 1) > pass) rot.push(list[i]);
        }
      }
      return rot;
    }

    function reportPlay(campaignId){
      try {
        var playToken = '';
        for (var i = 0; i < ADS.list.length; i++){
          if (ADS.list[i].id === campaignId){ playToken = ADS.list[i].play_token || ''; break; }
        }
        var xhr = new XMLHttpRequest();
        xhr.open('POST', apiBase() + '?id=' + encodeURIComponent(state.screenCode) + '&ad_play=1', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ campaign_id: campaignId, play_token: playToken }));
      } catch(e){}
    }

    function adAt(offset){
      if (!ADS.list.length) return null;
      return ADS.list[(ADS.idx + (offset || 0)) % ADS.list.length];
    }

    function stopAllAdMedia(){
      if (hasNativePlayer()){ try { window.NativePlayer.stop(); } catch(e){} }
      var els = adEls();
      if (ADS.imgTimer){ clearTimeout(ADS.imgTimer); ADS.imgTimer = null; }
      [els.a, els.b].forEach(function(v){
        if (!v) return;
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch(e){}
        v.classList.remove('showing');
        v.loop = false;
      });
      if (els.img) els.img.style.display = 'none';
      ADS.active = null;
      ADS.swapping = false;
    }

    function rememberCurrentAd(ad){
      if (!ad) return;
      deviceState.lastAdCampaignId = ad.id || null;
      deviceState.lastAdName = ad.name || null;
    }

    function updateAds(list){
      list = list || [];
      var sig = adsSignature(list);
      var els = adEls();
      if (!els.a || !els.b || !els.img) return;

      if (list.length === 0){
        if (document.body) document.body.classList.remove('ads-active');
        stopAllAdMedia();
        ADS.list = []; ADS.sig = ''; ADS.idx = 0;
        return;
      }

      if (document.body) document.body.classList.add('ads-active');

      if (sig !== ADS.sig){
        ADS.sig = sig;
        ADS.list = buildRotation(list);
        ADS.idx = 0;
        stopAllAdMedia();
        playCurrentAd();
      }
    }

    function prepareMediaElementForUrl(el, url){
      if (!el) return;
      try {
        if (mediaUrlAllowsCors(url)) el.crossOrigin = 'anonymous';
        else el.removeAttribute('crossorigin');
      } catch(e){}
    }

    function preloadNextInto(v){
      // IMPORTANT for LG SI/webOS: never load the same single ad into both
      // video elements. Some LG decoders hand the video surface to the hidden
      // element, causing the visible ad to flash briefly and then turn black.
      if (ADS.list.length <= 1) return;
      var nxt = adAt(1);
      if (!nxt) return;
      if (nxt.media_type === 'image'){
        // warm the browser cache so image->image transitions have no decode gap
        try { var pre = new Image(); var preUrl = mediaProxyUrl(nxt.media_url); pre.crossOrigin = 'anonymous'; pre.src = preUrl; } catch(e){}
        return;
      }
      if (!v) return;
      var nextMediaUrl = mediaProxyUrl(nxt.media_url);
      if (v.getAttribute('src') !== nextMediaUrl){
        try { prepareMediaElementForUrl(v, nextMediaUrl); v.setAttribute('src', nextMediaUrl); v.load(); } catch(e){}
      } else if (v.ended || v.readyState === 0){
        try { v.load(); } catch(e){} // finished last rotation: re-buffer now, not at swap time
      }
    }

    function playCurrentAd(){
      var els = adEls();
      if (!els.a || !els.b || !ADS.list.length) return;
      if (ADS.imgTimer){ clearTimeout(ADS.imgTimer); ADS.imgTimer = null; }
      var ad = adAt(0);
      if (!ad) return;
      rememberCurrentAd(ad);

      if (ad.media_type === 'image'){
        // Image ad: hide native surface / cover the videos with the image
        if (hasNativePlayer()){ try { window.NativePlayer.stop(); } catch(e){} }
        var imageMediaUrl = mediaProxyUrl(ad.media_url);
        prepareMediaElementForUrl(els.img, imageMediaUrl);
        els.img.src = imageMediaUrl;
        els.img.style.display = 'block';
        try { if (ADS.active) ADS.active.pause(); } catch(e){}
        var secs = Math.min(120, Math.max(3, Number(ad.image_duration) || 10));
        ADS.imgTimer = setTimeout(function(){ reportPlay(ad.id); nextAd(); }, secs * 1000);
        // Preload the next video ad behind the image so it starts instantly
        preloadNextInto(ADS.active === els.a ? els.b : els.a);
        return;
      }

      // Android APK path: hardware-decoded native playback with disk cache.
      // (native surface sits above the WebView, so hide the image immediately)
      if (hasNativePlayer()){
        els.img.style.display = 'none';
        nativePlayCurrent(ad);
        return;
      }
      // Browser path: leave the image covering the videos until the incoming
      // <video> fires 'playing' — the crossfade handler hides it then.

      // Single-ad rotation: use exactly one video decoder/surface.
      // Do not preload the same URL into the hidden buffer on LG SI/webOS.
      if (ADS.list.length === 1){
        var v0 = ADS.active || els.a;
        var hidden = (v0 === els.a) ? els.b : els.a;
        ADS.active = v0;
        v0.loop = true;

        // Release the hidden decoder completely. Keeping the same media loaded
        // in both elements can make commercial LG screens show black.
        if (hidden){
          try {
            hidden.pause();
            hidden.removeAttribute('src');
            hidden.load();
          } catch(e){}
          hidden.classList.remove('showing');
          hidden.loop = false;
        }

        var singleMediaUrl = mediaProxyUrl(ad.media_url);
        if (v0.getAttribute('src') !== singleMediaUrl){
          prepareMediaElementForUrl(v0, singleMediaUrl);
          v0.setAttribute('src', singleMediaUrl);
          try { v0.load(); } catch(e){}
        }
        startWhenReady(v0);
        return; // 'playing' listener reveals it
      }

      // Double-buffer swap: play into the element that is NOT showing.
      var incoming = (ADS.active === els.a) ? els.b : els.a;
      incoming.loop = false;
      var incomingMediaUrl = mediaProxyUrl(ad.media_url);
      if (incoming.getAttribute('src') !== incomingMediaUrl){
        prepareMediaElementForUrl(incoming, incomingMediaUrl);
        incoming.setAttribute('src', incomingMediaUrl);
        try { incoming.load(); } catch(e){}
      } else if (incoming.ended || incoming.readyState === 0){
        // Replaying a finished element without load() renders black on many TV engines
        try { incoming.load(); } catch(e){}
      } else {
        try { incoming.currentTime = 0; } catch(e){}
      }
      ADS.swapping = true;
      // webOS: play() before sufficient buffering shows a frame, stalls, and
      // restarts decode (visible "replay"). Start only when ready; the element
      // is hidden until 'playing' fires, so waiting costs nothing visually.
      startWhenReady(incoming);
      // Swap rescue: if no 'playing' within 5s, hard-reload once, then skip
      if (ADS.swapTimer) clearTimeout(ADS.swapTimer);
      ADS.swapTimer = setTimeout(function(){
        if (!ADS.swapping) return;
        if (!ADS.rescued){
          ADS.rescued = true;
          try { incoming.load(); startWhenReady(incoming); } catch(e){}
          ADS.swapTimer = setTimeout(function(){ if (ADS.swapping){ ADS.rescued = false; nextAd(); } }, 5000);
        } else { ADS.rescued = false; nextAd(); }
      }, 5000);
      // reveal + hide-old happens in the 'playing' listener below
    }

    function startWhenReady(v){
      function go(){
        var p = v.play();
        if (p && p.catch) p.catch(function(){});
      }
      if (v.readyState >= 3){ go(); return; }   // HAVE_FUTURE_DATA: safe to start
      var fired = false;
      function once(){
        if (fired) return; fired = true;
        v.removeEventListener('canplay', once);
        v.removeEventListener('canplaythrough', once);
        go();
      }
      v.addEventListener('canplay', once);
      v.addEventListener('canplaythrough', once);
      // belt-and-braces: if events never fire (some TV stacks), try anyway
      setTimeout(once, 2500);
    }

    function nextAd(){
      if (!ADS.list.length) return;
      ADS.idx = (ADS.idx + 1) % ADS.list.length;   // loop back to first
      playCurrentAd();
    }

    (function(){
      var els = adEls();
      if (!els.a || !els.b) return;

      function wire(v, other){
        v.addEventListener('playing', function(){
          // First decoded frame is ready: crossfade, never show the play overlay.
          v.classList.add('showing');
          if (ADS.active && ADS.active !== v){
            var old = ADS.active;
            old.classList.remove('showing');
            setTimeout(function(){ try { old.pause(); } catch(e){} }, 300);
          }
          ADS.active = v;
          ADS.swapping = false;
          ADS.rescued = false;
          if (ADS.swapTimer){ clearTimeout(ADS.swapTimer); ADS.swapTimer = null; }
          var imgEl = document.getElementById('ad-image');
          if (imgEl) imgEl.style.display = 'none'; // image stays up until this first frame
          // Preload only when there is a genuinely different next item.
          // Single-ad playback must keep the second LG decoder released.
          if (ADS.list.length > 1) preloadNextInto(other);
        });

        v.addEventListener('ended', function(){
          if (v !== ADS.active) return;
          var ad = adAt(0);
          if (ad) reportPlay(ad.id);
          if (ADS.list.length === 1){
            // Fallback for TV engines that ignore the loop property.
            try { v.currentTime = 0; } catch(e){}
            startWhenReady(v);
          } else {
            nextAd();
          }
        });

        // HTML video with loop=true usually suppresses the ended event. Detect
        // the currentTime wrap so single-ad proof-of-play still gets recorded.
        v.__asgLastTime = 0;
        v.addEventListener('timeupdate', function(){
          if (v !== ADS.active || ADS.list.length !== 1 || !v.loop) {
            v.__asgLastTime = v.currentTime || 0;
            return;
          }
          var nowT = v.currentTime || 0;
          if (v.__asgLastTime > 1 && nowT + 0.75 < v.__asgLastTime){
            var loopAd = adAt(0);
            if (loopAd) reportPlay(loopAd.id);
          }
          v.__asgLastTime = nowT;
        });

        v.addEventListener('error', function(){
          var ad = adAt(0);
          var mediaError = v.error ? ('MediaError ' + v.error.code) : 'Video playback error';
          reportPlayerError('video', mediaError, { campaign_id: ad && ad.id, media_url: ad && ad.media_url });
          if (ADS.swapping || v === ADS.active) setTimeout(nextAd, 3000); // skip broken file
        });
      }
      wire(els.a, els.b);
      wire(els.b, els.a);

      // Stall watchdog: if the active video freezes for 20s, move on.
      var lastT = 0, lastCheck = Date.now();
      setInterval(function(){
        var v = ADS.active;
        if (!ADS.list.length || !v || v.paused || v.loop) return;
        if (v.currentTime === lastT && Date.now() - lastCheck > 20000){ nextAd(); lastCheck = Date.now(); }
        else if (v.currentTime !== lastT){ lastT = v.currentTime; lastCheck = Date.now(); }
      }, 5000);
    })();

    function signatureFromData(data){
      try{
        var raw = Array.isArray(data && data.events) ? data.events : [];
        var norm = raw.map(function(ev){
          return {
            t: ev.teams || ev.title || '',
            d: ev.date || ev.start_date || '',
            ed: ev.end_date || ev.endDate || '',
            s: ev.start_time || ev.startTime || ev.start || ev.time || '',
            e: ev.end_time || ev.endTime || ev.end || '',
            r: ev.room || ev.location || ev.room_name || ''
          };
        });
        norm.sort(function(a, b){ 
          return String(a.s).localeCompare(String(b.s)); 
        });
        return JSON.stringify({
          title: data && data.rink_title || '',
          logo: data && data.rink_logo || '',
          tick: (data && (data.announcement || data.ticker_text)) || '',
          events: norm,
          theme: data && data.theme || null
        });
      } catch(e){ 
        return null; 
      }
    }
    
    function updateLiveProgressBars(){
      var bars = document.querySelectorAll('.progress[data-start] .progress-fill'); 
      var now = Date.now();
      var needsRefresh = false;
      
      for (var i = 0; i < bars.length; i++){ 
        var bar = bars[i];
        var holder = bar.parentElement; 
        var s = parseInt(holder.getAttribute('data-start'), 10);
        var e = parseInt(holder.getAttribute('data-end') || '0', 10); 
        
        if (!isNaN(s) && !isNaN(e) && e > s){ 
          var pct = Math.floor(((now - s) / (e - s)) * 100); 
          if (pct < 0) pct = 0; 
          if (pct > 100) {
            pct = 100;
            needsRefresh = true;
          }
          bar.style.width = pct + '%'; 
        } 
      }
      
      var eventRows = document.querySelectorAll('.event-row[data-end-time]');
      for (var j = 0; j < eventRows.length; j++) {
        var row = eventRows[j];
        var endTime = parseInt(row.getAttribute('data-end-time'), 10);
        if (endTime && now >= endTime) {
          needsRefresh = true;
          break;
        }
      }
      
      if (needsRefresh && state.lastPayload) {
        renderFromPayload(state.lastPayload);
      }
    }

    function renderFromPayload(data){
      var raw = (data && data.events) || [];
      var now = new Date();
      var title = (data && data.rink_title) || '';
      var logo = (data && data.rink_logo) || '';
      var ticker = (data && (data.announcement || data.ticker_text)) || '';
      
      if (data && data.registered) {
        setRegistrationStatus(true);
        state.lastSuccessfulData = data;
      }
      
      var events = [];
      
      for (var i = 0; i < raw.length; i++){
        var ev = raw[i] || {};
        var t = getEventTimes(ev);
        
        if (!t.start && !t.end) continue;
        if (t.end && now.getTime() >= t.end.getTime()) continue;
        
        ev.__start = t.start ? t.start.getTime() : Number.MAX_SAFE_INTEGER;
        ev.__times = t;
        events.push(ev);
      }
      
      events.sort(function(a, b){ 
        return a.__start - b.__start; 
      });
      
      if (events.length > 50) {
        events = events.slice(0, 50);
      }
      
      var titleEl = document.getElementById('rink-title');
      var headerLogo = document.getElementById('header-logo');
      if (titleEl) titleEl.textContent = title || 'Rink';
      if (headerLogo){ 
        if (logo){ 
          headerLogo.src = logo; 
          headerLogo.style.display = 'inline-block'; 
          headerLogo.onerror = function() {
            this.style.display = 'none';
          };
        } else { 
          headerLogo.removeAttribute('src'); 
          headerLogo.style.display = 'none'; 
        } 
      }
      
      var emptyLogo = document.getElementById('empty-logo');
      var emptyTitle = document.getElementById('empty-title');
      if (emptyTitle) {
        emptyTitle.textContent = title || '';
        emptyTitle.style.display = title ? 'block' : 'none';
      }
      if (emptyLogo){ 
        if (logo){ 
          emptyLogo.src = logo; 
          emptyLogo.style.display = 'inline-block'; 
          emptyLogo.onerror = function() {
            this.style.display = 'none';
          };
        } else { 
          emptyLogo.removeAttribute('src'); 
          emptyLogo.style.display = 'none'; 
        } 
      }
      
      updateTickerText(ticker);
      
      if (events && events.length){
        var html = '<div class="event-header">'
                 + '<div class="event-cell time">Time</div>'
                 + '<div class="event-cell">Event</div>'
                 + '<div class="event-cell room">Room</div>'
                 + '</div>';
        
        for (var j = 0; j < events.length; j++){
          var ev2 = events[j] || {};
          var teams = esc(ev2.teams || ev2.title || '');
          var startRaw = ev2.start_time || ev2.startTime || ev2.start || '';
          var endRaw = ev2.end_time || ev2.endTime || ev2.end || '';
          var room = esc(ev2.room || ev2.location || ev2.room_name || '');
          
          var timeStr = '';
          if (startRaw || endRaw){ 
            var a = to12h(startRaw);
            var b = to12h(endRaw); 
            timeStr = a && b ? (a + ' - ' + b) : (a || b); 
          } else if (ev2.time){ 
            timeStr = to12h(ev2.time); 
          }
          
          var start = ev2.__times.start;
          var end = ev2.__times.end;
          var isLive = false;
          var pct = null;
          var sMs = null;
          var eMs = null;
          
          if (start){
            var n = now.getTime();
            var s = start.getTime();
            var e = end ? end.getTime() : null;
            sMs = s; 
            eMs = e;
            
            if (n >= s && (e === null || n < e)){
              isLive = true;
              if (e !== null && e > s){
                pct = Math.floor(((n - s) / (e - s)) * 100);
                if (pct < 0) pct = 0; 
                if (pct > 100) pct = 100;
              }
            }
          }
          
          html += '<div class="event-row' + (isLive ? ' live' : '') + '" data-end-time="' + (eMs || '') + '">'
               +  '<div class="event-cell time">' + (timeStr || '') + '</div>'
               +  '<div class="event-cell">' + teams + (isLive ? ' <span class="live-pill">LIVE</span>' : '') + '</div>'
               +  '<div class="event-cell room">' + room + '</div>'
               +  '</div>';
          
          if (isLive && pct !== null){ 
            html += '<div class="progress" data-start="' + sMs + '" data-end="' + eMs + '">'
                 +  '<div class="progress-fill" style="width:' + pct + '%"></div></div>'; 
          }
        }
        
        var eventsEl = document.getElementById('events');
        if (eventsEl){ 
          eventsEl.innerHTML = html; 
          eventsEl.scrollTop = 0; 
          startAutoScroll(); 
        }
        
        hide('code-screen');
        show('header');
        show('event-screen');
        hide('empty-screen');
        dismissOverlay();
      } else {
        hide('code-screen');
        show('header');
        hide('event-screen');
        show('empty-screen');
        stopAutoScroll();
        dismissOverlay();
      }
    }
    
    function startAutoScroll(){
      var el = document.getElementById('events');
      if (!el) return;
      stopAutoScroll();
      el.scrollTop = 0;
      if (state.userInteracting) return;

      // Snap page boundaries to whole rows so nothing gets cut in half
      function buildPages(){
        var header = el.querySelector('.event-header');
        var headerH = header ? header.offsetHeight : 0;
        var viewH = el.clientHeight - headerH;
        var rows = el.querySelectorAll('.event-row');
        var starts = [0];
        if (el.scrollHeight <= el.clientHeight + 2 || rows.length === 0) return starts;
        var cur = 0, guard = 0;
        while (guard++ < 300){
          var top = rows[cur].offsetTop;
          var bottom = top + viewH;
          var next = cur;
          while (next < rows.length && (rows[next].offsetTop + rows[next].offsetHeight) <= bottom) next++;
          if (next <= cur) next = cur + 1;          // single row taller than a page
          if (next >= rows.length) break;
          starts.push(Math.max(0, rows[next].offsetTop - headerH));
          cur = next;
        }
        return starts;
      }

      // Defer a frame so row heights (incl. live progress bars) are final
      requestAnimationFrame(function(){
        var starts = buildPages();
        if (starts.length <= 1){ el.scrollTop = 0; return; }   // it all fits: no paging needed

        state.pageStarts = starts;
        state.pageIndex = 0;
        var fade = CONFIG.PAGE_FADE;
        el.style.transition = 'opacity ' + fade + 'ms ease';

        state.pageTimer = setInterval(function(){
          if (state.userInteracting) return;
          el.style.opacity = '0';                              // fade out
          setTimeout(function(){
            state.pageIndex = (state.pageIndex + 1) % state.pageStarts.length;
            el.scrollTop = state.pageStarts[state.pageIndex];  // jump a full page
            el.style.opacity = '1';                            // fade in
          }, fade);
        }, CONFIG.PAGE_INTERVAL);
      });
    }

    function stopAutoScroll(){
      if (state.pageTimer){ clearInterval(state.pageTimer); state.pageTimer = null; }
      if (state.scrollTimer){ clearInterval(state.scrollTimer); state.scrollTimer = null; }
      if (state.scrollPause){ clearTimeout(state.scrollPause); state.scrollPause = null; }
      var el = document.getElementById('events');
      if (el){ el.style.opacity = '1'; }
    }

    function setupEventListeners() {
      var eventsContainer = document.getElementById('events');
      if (eventsContainer) {
        eventsContainer.addEventListener('mouseenter', function() {
          state.userInteracting = true;
          stopAutoScroll();
        });
        
        eventsContainer.addEventListener('mouseleave', function() {
          state.userInteracting = false;
          setTimeout(function() {
            if (!state.userInteracting) startAutoScroll();
          }, 2000);
        });
        
        eventsContainer.addEventListener('touchstart', function() {
          state.userInteracting = true;
          stopAutoScroll();
        });
        
        eventsContainer.addEventListener('touchend', function() {
          setTimeout(function() {
            state.userInteracting = false;
            if (!state.userInteracting) startAutoScroll();
          }, 5000);
        });
      }
    }
    
    function maybeRender(data){
      var sig = signatureFromData(data);

      state.lastPayload = data;

      if (data && data.theme) {
        // Ensure live_badge and progress_bar are included (may come from API at top level)
        var theme = data.theme;
        if (!theme.live_badge && data.theme_live_badge) {
          theme.live_badge = data.theme_live_badge;
        }
        if (!theme.progress_bar && data.theme_progress_bar) {
          theme.progress_bar = data.theme_progress_bar;
        }
        applyTheme(theme);
        state.currentTheme = theme;
        setCacheWithExpiry('theme_' + state.screenCode, theme);
      }
      
      if (data && data.font_scale) {
        applyFontScale(data.font_scale);
      }
      
      if (data && data.rink_id && data.rink_id !== currentRinkId) {
        console.log('Rink ID changed, subscribing to realtime:', data.rink_id);
        subscribeToRealtime(data.rink_id);
      }
      
      if (sig && sig === state.lastSignature){ 
        updateTickerText((data && (data.announcement || data.ticker_text)) || '');
        updateAds(data && data.ads);
        updateTomorrow(data);
        updateLiveProgressBars(); 
        return; 
      }
      
      state.lastSignature = sig;
      updateAds(data && data.ads);
      updateTomorrow(data);
      setCacheWithExpiry('last_payload_' + state.screenCode, data);
      renderFromPayload(data);
    }
    
    async function checkScreenGroup(rinkId) {
      if (!supabaseClient || !rinkId) return null;

      try {
        // Check if this rink is part of an active group
        const { data: membership, error: memberError } = await supabaseClient
          .from('screen_group_members')
          .select(`
            id,
            is_master,
            group_id,
            screen_groups!inner (
              id,
              active
            )
          `)
          .eq('rink_id', rinkId)
          .eq('screen_groups.active', true)
          .single();

        if (memberError || !membership || membership.is_master) {
          // Not in a group, or is the master, so show own content
          return null;
        }

        // This screen is a follower - find the master
        const { data: master, error: masterError } = await supabaseClient
          .from('screen_group_members')
          .select(`
            rink_id,
            rinks!inner (
              id,
              screen_code
            )
          `)
          .eq('group_id', membership.group_id)
          .eq('is_master', true)
          .single();

        if (masterError || !master) {
          console.log('No master found for group');
          return null;
        }

        // Return the master's screen code
        return master.rinks.screen_code;
      } catch (e) {
        console.log('Error checking screen group:', e);
        return null;
      }
    }

    function checkAndLoadEvents(forceFresh){
      if (isPreviewMode()) {
        return;
      }

      state.retryCount = 0;

      console.log('=== API CHECK ===');
      console.log('Current screen code:', state.screenCode);
      console.log('Stored in localStorage:', getLocal('screen_uuid'));
      var requestUrl = buildApiUrl() + (forceFresh ? '&fresh=1' : '');
      console.log('API URL:', requestUrl);

      xhrGetWithRetry(
        requestUrl,
        function(txt){
          var data = null;
          try{
            data = JSON.parse(txt);
            if (data) {
              markContentHealthy();
              deviceState.lastContentSyncAt = new Date().toISOString();
            }
          } catch(e){
            console.log('JSON parse error:', e);
          }

          console.log('=== API RESPONSE ===');
          console.log('Registered:', data && data.registered);
          console.log('Events count:', data && data.events ? data.events.length : 0);
          console.log('Rink title:', data && data.rink_title);
          
          // Check for API errors (503 database errors)
          if (data && data.error === 'database_error') {
            console.error('>>> DATABASE ERROR - Using cached data if available');
            // Try to use cached data
            var cache = getCacheWithExpiry('last_payload_' + state.screenCode);
            if (cache && cache.registered !== false) {
              maybeRender(cache);
              return;
            }
            // If no cache and was previously registered, show empty screen
            if (getRegistrationStatus() && state.lastSuccessfulData) {
              maybeRender({
                registered: true,
                rink_title: state.lastSuccessfulData.rink_title || '',
                rink_logo: state.lastSuccessfulData.rink_logo || '',
                ticker_text: state.lastSuccessfulData.ticker_text || '',
                events: [],
                theme: state.currentTheme
              });
              return;
            }
            // Otherwise show code screen
            show('code-screen');
            hide('header');
            hide('event-screen');
            hide('empty-screen');
            stopAutoScroll();
            dismissOverlay();
            return;
          }
          
          if (!data || data.registered === false) {
            console.log('>>> SHOWING CODE SCREEN (not registered)');
            setRegistrationStatus(false);
            show('code-screen');
            hide('header');
            hide('event-screen');
            hide('empty-screen');
            stopAutoScroll();
            dismissOverlay();
            return;
          }

          // Check if this screen is part of a group and should mirror master
          if (data && data.rink_id) {
            checkScreenGroup(data.rink_id).then(function(masterScreenCode) {
              if (masterScreenCode && masterScreenCode !== state.screenCode) {
                console.log('>>> SCREEN IS IN GROUP - Loading master content from:', masterScreenCode);
                // Load master's content instead
                var masterUrl = apiBase() + '?id=' +
                               encodeURIComponent(masterScreenCode);
                xhrGetWithRetry(
                  masterUrl,
                  function(masterTxt) {
                    try {
                      var masterData = JSON.parse(masterTxt);
                      if (masterData && masterData.registered) {
                        console.log('>>> RENDERING MASTER CONTENT');
                        maybeRender(masterData);
                      } else {
                        console.log('>>> MASTER NOT REGISTERED - Showing own content');
                        maybeRender(data);
                      }
                    } catch(e) {
                      console.log('>>> ERROR LOADING MASTER - Showing own content');
                      maybeRender(data);
                    }
                  },
                  function(error) {
                    console.log('>>> FAILED TO LOAD MASTER - Showing own content');
                    maybeRender(data);
                  }
                );
              } else {
                // Check for combined display layout (fetch settings from DB)
                checkAndLoadCombinedIfNeeded(data).then(function(success) {
                  if (!success) {
                    console.log('>>> RENDERING EVENTS (registered)');
                    document.body.classList.remove('combined-mode');
                    var combinedContainer = document.getElementById('combined-display');
                    if (combinedContainer) combinedContainer.className = '';
                    maybeRender(data);
                  }
                }).catch(function(error) {
                  console.log('>>> COMBINED DISPLAY ERROR - Showing single rink');
                  document.body.classList.remove('combined-mode');
                  maybeRender(data);
                });
              }
            }).catch(function(error) {
              console.log('>>> ERROR CHECKING GROUP - Showing own content');
              maybeRender(data);
            });
          } else {
            // Check for combined display layout (fetch settings from DB)
            checkAndLoadCombinedIfNeeded(data).then(function(success) {
              if (!success) {
                console.log('>>> RENDERING EVENTS (registered)');
                document.body.classList.remove('combined-mode');
                var combinedContainer = document.getElementById('combined-display');
                if (combinedContainer) combinedContainer.className = '';
                maybeRender(data);
              }
            }).catch(function(error) {
              console.log('>>> COMBINED DISPLAY ERROR - Showing single rink');
              document.body.classList.remove('combined-mode');
              maybeRender(data);
            });
          }
        }, 
        function(error){
          console.log('API call failed:', error);
          
          var cache = getCacheWithExpiry('last_payload_' + state.screenCode);
          if (cache && cache.registered !== false) {
            maybeRender(cache);
            return;
          }
          
          if (getRegistrationStatus() && state.lastSuccessfulData) {
            maybeRender({
              registered: true,
              rink_title: state.lastSuccessfulData.rink_title || '',
              rink_logo: state.lastSuccessfulData.rink_logo || '',
              ticker_text: state.lastSuccessfulData.ticker_text || '',
              events: [],
              theme: state.currentTheme
            });
            return;
          }
          
          show('code-screen');
          hide('header');
          hide('event-screen');
          hide('empty-screen');
          stopAutoScroll();
          dismissOverlay();
        }
      );
    }
    
    function scheduleNightlyRefresh() {
      var now = new Date();
      var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 3, 0, 0, 0);
      var msUntilRefresh = tomorrow.getTime() - now.getTime();
      
      setTimeout(function() {
        location.reload(true);
      }, msUntilRefresh);
    }
    
    window.addEventListener('beforeunload', function() {
      stopAutoScroll();
      if (state.pollHandle) clearInterval(state.pollHandle);
      if (TICKER.animFrame) cancelAnimationFrame(TICKER.animFrame);
      if (realtimeChannel && supabaseClient) {
        supabaseClient.removeChannel(realtimeChannel);
      }
    });
    
    function checkEventStatus() {
      if (!state.lastPayload || !state.lastPayload.events) return;
      
      var now = new Date();
      var needsRerender = false;
      
      var events = state.lastPayload.events || [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var times = getEventTimes(ev);
        
        if (!times.start || !times.end) continue;
        
        var startTime = times.start.getTime();
        var endTime = times.end.getTime();
        var nowTime = now.getTime();
        
        var wasLive = ev.__wasLive || false;
        var isLiveNow = (nowTime >= startTime && nowTime < endTime);
        var isExpired = (nowTime >= endTime);
        
        if (isExpired && !ev.__expired) {
          needsRerender = true;
          ev.__expired = true;
        } else if (!wasLive && isLiveNow) {
          needsRerender = true;
          ev.__wasLive = true;
        }
      }
      
      if (needsRerender) {
        renderFromPayload(state.lastPayload);
      }

      // Also update combined display if active
      if (state.combinedLayout && state.combinedRinks && state.combinedRinks.length > 0) {
        updateCombinedDisplay();
      }
    }
    
    detectPlatform();
    applyOrientation();
    state.screenCode = getOrCreateScreenCode();
    state.isRegistered = getRegistrationStatus();

    console.log('==== INITIALIZATION ====');
    console.log('Screen code set to:', state.screenCode);
    console.log('Stored in localStorage:', getLocal('screen_uuid'));
    console.log('Registration status:', state.isRegistered);

    initSupabase();

    loadCachedTheme();

    if (isPreviewMode()) {
      applyPreviewTheme();
    } else {
      var codeEl = document.getElementById('screen-code');
      if (codeEl) codeEl.textContent = state.screenCode;
      
      // Health heartbeat + event-loop freeze watchdog.
      // A completely frozen JS engine cannot report while stalled, so the watchdog
      // detects the long timer drift as soon as execution resumes, reports `frozen`,
      // and reports `recovered` only after content has loaded successfully again.
      healthState = {
        freezeCount: Number(getLocal('freeze_count_' + state.screenCode) || 0),
        lastWatchdogTick: Date.now(),
        frozenAt: 0,
        recoveryPending: false,
        contentHealthyAfterFreeze: false
      };

      function sendHealthEvent(eventType, done) {
        if (!state.screenCode) return;
        try {
          var xhr = new XMLHttpRequest();
          var url = buildApiUrl() + '&health=1';
          var payload = JSON.stringify({
            screen_code: state.screenCode,
            timestamp: new Date().toISOString(),
            event_type: eventType || 'heartbeat',
            freeze_count: healthState.freezeCount
          });

          xhr.open('POST', url, true);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.timeout = 5000;
          xhr.onload = function() {
            var ok = xhr.status >= 200 && xhr.status < 300;
            if (!ok) console.log('Health event failed:', eventType, xhr.status);
            if (done) done(ok);
          };
          xhr.onerror = function() { if (done) done(false); };
          xhr.ontimeout = function() { if (done) done(false); };
          xhr.send(payload);
        } catch(e) {
          console.log('Health event error:', e);
          if (done) done(false);
        }
      }

      function sendHeartbeat() {
        if (healthState.recoveryPending) {
          var heldLongEnough = Date.now() - healthState.frozenAt >= CONFIG.FREEZE_RECOVERY_HOLD;
          if (healthState.contentHealthyAfterFreeze && heldLongEnough) {
            sendHealthEvent('recovered', function(ok) {
              if (ok) {
                healthState.recoveryPending = false;
                healthState.contentHealthyAfterFreeze = false;
              }
            });
          } else {
            // Keep the admin status visibly frozen until a healthy content load occurs.
            sendHealthEvent('frozen');
          }
          return;
        }
        sendHealthEvent('heartbeat');
      }

      function watchdogTick() {
        var now = Date.now();
        var elapsed = now - healthState.lastWatchdogTick;
        healthState.lastWatchdogTick = now;

        // Avoid false positives while a browser tab is intentionally backgrounded.
        if (typeof document.hidden !== 'undefined' && document.hidden) return;

        var drift = elapsed - CONFIG.WATCHDOG_INTERVAL;
        if (drift > CONFIG.FREEZE_THRESHOLD && !healthState.recoveryPending) {
          healthState.freezeCount += 1;
          setLocal('freeze_count_' + state.screenCode, String(healthState.freezeCount));
          healthState.frozenAt = now;
          healthState.recoveryPending = true;
          healthState.contentHealthyAfterFreeze = false;
          sendHealthEvent('frozen');
        }
      }

      sendHealthEvent('boot');
      sendDeviceStatus();
      setTimeout(checkForPlayerUpdate, 1500);
      setInterval(checkForPlayerUpdate, 300000);
      setTimeout(pollRemoteCommand, 2500);
      setInterval(sendHeartbeat, CONFIG.HEARTBEAT_INTERVAL);
      setInterval(sendDeviceStatus, CONFIG.DEVICE_STATUS_INTERVAL);
      setInterval(pollRemoteCommand, CONFIG.COMMAND_POLL_INTERVAL);
      setInterval(watchdogTick, CONFIG.WATCHDOG_INTERVAL);

      updateClock();
      setInterval(updateClock, 1000);
      setInterval(updateLiveProgressBars, CONFIG.PROGRESS_UPDATE_INTERVAL);
      
      setInterval(checkEventStatus, 1000);
      
      setTimeout(setupEventListeners, 100);
      
      checkAndLoadEvents(); 
      if (state.pollHandle) clearInterval(state.pollHandle);
      state.pollHandle = setInterval(checkAndLoadEvents, CONFIG.POLL_INTERVAL);
      
      scheduleNightlyRefresh();
    }
    
    // Cancel any existing animation frame before starting new loop
    if (TICKER.animFrame) cancelAnimationFrame(TICKER.animFrame);
    animationLoop(performance.now());
  })();
  