// PelakaVoice 2 - voice, screen sharing, friends, themes, hosting & in-app updates

(function() {
  const state = {
    username: localStorage.getItem('pv_nick') || '',
    tag: localStorage.getItem('pv_tag') || '',
    avatarColor: localStorage.getItem('pv_col') || '#3b82f6',
    serverUrl: localStorage.getItem('pv_srv') || '',

    currentLobby: null,
    inDirectCall: false,
    activeDirectCallId: null,
    directCallPartner: null,
    pendingIncomingCall: null,

    // Screen sharing
    isSharingScreen: false,
    localScreenStream: null,

    // Collections
    lobbies: [],
    lobbyPeers: new Map(), // peerId -> userData
    friends: new Map(),    // tag -> friendData
    selectedFriend: null,
    activeContextPeerId: null,

    audioEngine: null,
    webrtc: null,
    socket: null,
    isLocalServerRunning: false,
    loggedIn: false,
    lobbyPassword: '',
    screenPeerId: null,
    inviteCode: '',
    appVersion: '',
    pingTimer: null,
    lobbiesRendered: false,
    lobbyChat: [],
    sounds: [],
    upload: null,
    dms: new Map(),      // friend tag -> [{ author, text, mine, ts }]
    dmUnread: new Map(), // friend tag -> unread count
    screenQuality: localStorage.getItem('pv_sq') || '1080p60',
    armedDelete: null,
    pttKey: localStorage.getItem('pv_ptt') || 'Space',
    armedTimer: null
  };

  const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;

  // DOM Elements
  const el = {
    loginScreen: document.getElementById('login-screen'),
    appScreen: document.getElementById('app-screen'),

    // Login
    inputNickname: document.getElementById('input-nickname'),
    colorPicker: document.getElementById('color-picker'),
    inputServerUrl: document.getElementById('input-server-url'),
    hostPanel: document.getElementById('host-panel'),
    btnHostOnline: document.getElementById('btn-host-online'),
    btnHostLan: document.getElementById('btn-host-lan'),
    hostStatus: document.getElementById('host-status'),
    hostStatusText: document.getElementById('host-status-text'),
    hostInvite: document.getElementById('host-invite'),
    hostInviteCode: document.getElementById('host-invite-code'),
    btnCopyInvite: document.getElementById('btn-copy-invite'),
    btnHostStop: document.getElementById('btn-host-stop'),
    btnNavInvite: document.getElementById('btn-nav-invite'),
    loginError: document.getElementById('login-error'),
    btnLoginSubmit: document.getElementById('btn-login-submit'),

    // Top Bar & Segments
    navSegments: document.querySelectorAll('.segment-btn'),
    stageTabs: document.querySelectorAll('.stage-tab'),
    nodePingText: document.getElementById('node-ping-text'),
    connectionBadge: document.getElementById('connection-badge'),
    badgeIncomingMsg: document.getElementById('badge-incoming-msg'),
    toastStack: document.getElementById('toast-stack'),
    screenStats: document.getElementById('screen-stats'),
    qualityBtns: document.querySelectorAll('.q-btn'),
    btnDeleteLobby: document.getElementById('btn-delete-lobby'),
    lobbyChatList: document.getElementById('lobby-chat-list'),
    inputLobbyChat: document.getElementById('input-lobby-chat'),
    btnSendLobbyChat: document.getElementById('btn-send-lobby-chat'),
    soundGrid: document.getElementById('sound-grid'),
    soundCount: document.getElementById('sound-count'),
    btnAddSound: document.getElementById('btn-add-sound'),
    sliderSbVolume: document.getElementById('slider-sb-volume'),
    sbVolumeLabel: document.getElementById('sb-volume-label'),
    btnSbStop: document.getElementById('btn-sb-stop'),
    modalAddSound: document.getElementById('modal-add-sound'),
    soundDrop: document.getElementById('sound-drop'),
    inputSoundFile: document.getElementById('input-sound-file'),
    soundFileLabel: document.getElementById('sound-file-label'),
    inputSoundName: document.getElementById('input-sound-name'),
    soundLenBtns: document.querySelectorAll('.len-btn'),
    soundTrimBox: document.getElementById('sound-trim-box'),
    sliderSoundStart: document.getElementById('slider-sound-start'),
    soundStartLabel: document.getElementById('sound-start-label'),
    btnPreviewSound: document.getElementById('btn-preview-sound'),
    addSoundError: document.getElementById('add-sound-error'),
    btnSubmitSound: document.getElementById('btn-submit-sound'),

    // Lobbies Tab
    lobbiesBrowserView: document.getElementById('lobbies-browser-view'),
    activeLobbyStage: document.getElementById('active-lobby-stage'),
    lobbiesGrid: document.getElementById('lobbies-grid'),
    btnOpenCreateLobby: document.getElementById('btn-open-create-lobby'),
    activeLobbyIcon: document.getElementById('active-lobby-icon'),
    activeLobbyTitle: document.getElementById('active-lobby-title'),
    activeLobbyMeta: document.getElementById('active-lobby-meta'),
    btnBackToLobbies: document.getElementById('btn-back-to-lobbies'),
    btnLeaveLobby: document.getElementById('btn-leave-lobby'),
    participantsGrid: document.getElementById('participants-grid'),

    // Screen Share
    screenShareContainer: document.getElementById('screen-share-container'),
    screenShareVideo: document.getElementById('screen-share-video'),
    screenPresenterName: document.getElementById('screen-presenter-name'),
    btnToggleFullscreen: document.getElementById('btn-toggle-fullscreen'),

    // Friends Tab
    myTagText: document.getElementById('my-tag-text'),
    inputAddFriendTag: document.getElementById('input-add-friend-tag'),
    btnSubmitAddFriend: document.getElementById('btn-submit-add-friend'),
    addFriendError: document.getElementById('add-friend-error'),
    friendsList: document.getElementById('friends-list'),
    directEmptyState: document.getElementById('direct-empty-state'),
    directActiveState: document.getElementById('direct-active-state'),
    directTargetAvatar: document.getElementById('direct-target-avatar'),
    directTargetName: document.getElementById('direct-target-name'),
    directTargetStatus: document.getElementById('direct-target-status'),
    btnStartDirectCall: document.getElementById('btn-start-direct-call'),
    btnEndDirectCall: document.getElementById('btn-end-direct-call'),
    directScreenContainer: document.getElementById('direct-screen-container'),
    directScreenVideo: document.getElementById('direct-screen-video'),
    directCallActiveBanner: document.getElementById('direct-call-active-banner'),
    directChatMessages: document.getElementById('direct-chat-messages'),
    inputDirectChat: document.getElementById('input-direct-chat'),
    btnSendDirectChat: document.getElementById('btn-send-direct-chat'),

    // Settings
    gateStatusLabel: document.getElementById('gate-status-label'),
    labDbFill: document.getElementById('lab-db-fill'),
    labGateMarker: document.getElementById('lab-gate-marker'),
    sliderGateThreshold: document.getElementById('slider-gate-threshold'),
    badgeGateThreshold: document.getElementById('badge-gate-threshold'),
    selectMicDevice: document.getElementById('select-mic-device'),
    checkPushToTalk: document.getElementById('check-push-to-talk'),
    btnLabLogout: document.getElementById('btn-lab-logout'),

    // Dock
    dockAvatar: document.getElementById('dock-avatar'),
    dockAvatarLetter: document.getElementById('dock-avatar-letter'),
    dockUsername: document.getElementById('dock-username'),
    dockChannelName: document.getElementById('dock-channel-name'),
    dockBtnMute: document.getElementById('dock-btn-mute'),
    dockMuteLabel: document.getElementById('dock-mute-label'),
    dockBtnDeafen: document.getElementById('dock-btn-deafen'),
    dockDeafenLabel: document.getElementById('dock-deafen-label'),
    dockBtnScreen: document.getElementById('dock-btn-screen'),
    dockScreenLabel: document.getElementById('dock-screen-label'),
    dockBtnDisengage: document.getElementById('dock-btn-disengage'),

    // Context Menu
    participantContextMenu: document.getElementById('participant-context-menu'),
    contextUserAvatar: document.getElementById('context-user-avatar'),
    contextUserName: document.getElementById('context-user-name'),
    contextVolumeSlider: document.getElementById('context-volume-slider'),
    contextVolumeLabel: document.getElementById('context-volume-label'),
    btnContextMutePeer: document.getElementById('btn-context-mute-peer'),
    btnContextResetPeer: document.getElementById('btn-context-reset-peer'),

    // Modals
    modalScreenPicker: document.getElementById('modal-screen-picker'),
    screenSourcesGrid: document.getElementById('screen-sources-grid'),

    modalIncomingCall: document.getElementById('modal-incoming-call'),
    incomingCallerName: document.getElementById('incoming-caller-name'),
    btnIncomingAccept: document.getElementById('btn-incoming-accept'),
    btnIncomingDecline: document.getElementById('btn-incoming-decline'),

    // Updates & appearance
    updatePill: document.getElementById('update-pill'),
    updatePillText: document.getElementById('update-pill-text'),
    btnCheckUpdate: document.getElementById('btn-check-update'),
    appVersionText: document.getElementById('app-version-text'),

    modalCreatePod: document.getElementById('modal-create-pod'),
    createPodName: document.getElementById('create-pod-name'),
    createPodCapacity: document.getElementById('create-pod-capacity'),
    createPodPrivate: document.getElementById('create-pod-private'),
    podPasscodeGroup: document.getElementById('pod-passcode-group'),
    createPodPasscode: document.getElementById('create-pod-passcode'),
    createPodError: document.getElementById('create-pod-error'),
    btnSubmitCreatePod: document.getElementById('btn-submit-create-pod'),

    modalEnterPasscode: document.getElementById('modal-enter-passcode'),
    passcodeModalDesc: document.getElementById('passcode-modal-desc'),
    inputEnterPasscode: document.getElementById('input-enter-passcode'),
    enterPasscodeError: document.getElementById('enter-passcode-error'),
    btnSubmitEnterPasscode: document.getElementById('btn-submit-enter-passcode')
  };

  state.audioEngine = new window.AudioEngine();
  state.soundboard = new window.Soundboard(state.audioEngine);

  // Bridge used by qol.js and fun.js
  window.pv = {
    state, el, icon,
    toast: (m, k) => toast(m, k),
    escapeHtml: (t) => escapeHtml(t),
    safeColor: (c) => safeColor(c),
    fmtTime: (t) => fmtTime(t),
    toggleMute: () => toggleMute(),
    toggleDeafen: () => toggleDeafen(),
    refreshDevices: () => populateAudioInputDevices()
  };

  init();

  function init() {
    if (state.username) el.inputNickname.value = state.username;
    if (state.serverUrl) el.inputServerUrl.value = state.serverUrl;
    loadFriends();

    setupThemes();
    setupColorPicker();
    setupNavigationSegments();
    setupAudioSettings();
    setupContextMenu();
    setupAutoUpdater();
    setupLobbyExtras();

    setupHosting();

    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const m = document.getElementById(btn.getAttribute('data-close'));
        if (m) m.classList.add('hidden');
      });
    });

    el.btnLoginSubmit.addEventListener('click', handleLogin);
    [el.inputNickname, el.inputServerUrl].forEach(input => input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    }));
    el.inputEnterPasscode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleJoinPrivateLobby();
    });

    // Lobbies
    el.btnOpenCreateLobby.addEventListener('click', openCreateLobbyModal);
    el.createPodPrivate.addEventListener('change', () => {
      if (el.createPodPrivate.checked) el.podPasscodeGroup.classList.remove('hidden');
      else el.podPasscodeGroup.classList.add('hidden');
    });
    el.btnSubmitCreatePod.addEventListener('click', handleCreateLobby);
    el.btnSubmitEnterPasscode.addEventListener('click', handleJoinPrivateLobby);
    el.btnLeaveLobby.addEventListener('click', leaveLobby);
    el.btnBackToLobbies.addEventListener('click', () => {
      el.activeLobbyStage.classList.remove('active');
      el.lobbiesBrowserView.classList.add('active');
    });

    // Screen Share Fullscreen
    el.btnToggleFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        el.screenShareVideo.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Friends
    el.btnSubmitAddFriend.addEventListener('click', handleAddFriend);
    el.inputAddFriendTag.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAddFriend();
    });
    el.btnStartDirectCall.addEventListener('click', startDirectCall);
    el.btnEndDirectCall.addEventListener('click', endDirectCall);
    el.btnIncomingAccept.addEventListener('click', acceptIncomingCall);
    el.btnIncomingDecline.addEventListener('click', declineIncomingCall);

    el.btnSendDirectChat.addEventListener('click', sendDirectMessage);
    el.inputDirectChat.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendDirectMessage();
    });

    // Dock
    el.dockBtnMute.addEventListener('click', toggleMute);
    el.dockBtnDeafen.addEventListener('click', toggleDeafen);
    el.dockBtnScreen.addEventListener('click', toggleScreenShare);
    el.dockBtnDisengage.addEventListener('click', () => {
      if (state.inDirectCall) endDirectCall();
      else if (state.currentLobby) leaveLobby();
    });

    // Hotkeys
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey && state.pttKey !== 'KeyM') toggleMute();
      if (state.audioEngine.pushToTalkEnabled && e.code === state.pttKey && !e.repeat) {
        e.preventDefault();
        state.audioEngine.setPttPressed(true);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (state.audioEngine.pushToTalkEnabled && e.code === state.pttKey) {
        state.audioEngine.setPttPressed(false);
      }
    });

    populateAudioInputDevices();
  }

  // Segment Navigation
  function setupNavigationSegments() {
    el.navSegments.forEach(btn => {
      btn.addEventListener('click', () => {
        el.navSegments.forEach(b => b.classList.remove('active'));
        el.stageTabs.forEach(tab => tab.classList.remove('active'));

        btn.classList.add('active');
        const tabId = btn.getAttribute('data-tab');
        const targetTab = document.getElementById(tabId);
        if (targetTab) targetTab.classList.add('active');
        state.audioEngine.setMetering(tabId === 'tab-settings');
        if (tabId === 'tab-friends' && state.selectedFriend) markRead(state.selectedFriend.tag);
        if (tabId === 'tab-lobbies') { state.lobbiesRendered = false; renderLobbies(); }

        if (btn.getAttribute('data-tab') === 'tab-lobbies' && state.currentLobby) {
          el.lobbiesBrowserView.classList.remove('active');
          el.activeLobbyStage.classList.add('active');
        }
      });
    });
  }

  // Color picker
  function setupColorPicker() {
    const swatches = el.colorPicker.querySelectorAll('.swatch');
    swatches.forEach(sw => {
      const c = sw.getAttribute('data-color');
      if (c === state.avatarColor) sw.classList.add('active');
      sw.addEventListener('click', () => {
        swatches.forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
        state.avatarColor = c;
        localStorage.setItem('pv_col', c);
      });
    });
  }

  // Audio Settings & Metering
  function setupAudioSettings() {
    const applyGate = () => {
      const val = parseInt(el.sliderGateThreshold.value, 10);
      el.badgeGateThreshold.textContent = val + '%';
      el.labGateMarker.style.left = val + '%';
      state.audioEngine.setGateThreshold(val / 100);
      localStorage.setItem('pv_gate', String(val));
    };
    const savedGate = parseInt(localStorage.getItem('pv_gate'), 10);
    if (savedGate >= 5 && savedGate <= 80) el.sliderGateThreshold.value = savedGate;
    applyGate();
    el.sliderGateThreshold.addEventListener('input', applyGate);

    el.checkPushToTalk.addEventListener('change', () => {
      state.audioEngine.setPushToTalk(el.checkPushToTalk.checked);
    });

    state.audioEngine.onVolumeChange = (vol) => {
      el.labDbFill.style.transform = `scaleX(${vol.toFixed(3)})`;
    };

    state.audioEngine.onSpeakingChange = (speaking) => {
      const myCard = document.getElementById('participant-card-self');
      if (myCard) myCard.classList.toggle('speaking', speaking);
      el.gateStatusLabel.textContent = speaking ? 'Transmitting' : 'Silent';
      el.gateStatusLabel.classList.toggle('live', speaking);

      if (state.socket) {
        state.socket.emit('update_state', {
          isSpeaking: speaking,
          targetCallPeer: state.inDirectCall && state.directCallPartner ? state.directCallPartner.id : null
        });
      }
    };

    el.btnLabLogout.addEventListener('click', () => {
      leaveLobby();
      if (state.inDirectCall) endDirectCall();
      state.loggedIn = false;
      clearInterval(state.pingTimer);
      if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); state.socket = null; }
      setLoginBusy(false);
      el.appScreen.classList.remove('active');
      el.loginScreen.classList.add('active');
    });
  }

  // ================= CONTEXT MENU FOR USER VOLUME =================
  function setupContextMenu() {
    // Hide context menu on outside click
    document.addEventListener('click', (e) => {
      if (!el.participantContextMenu.contains(e.target)) {
        el.participantContextMenu.classList.add('hidden');
      }
    });

    el.contextVolumeSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      el.contextVolumeLabel.textContent = val + '%';
      if (state.activeContextPeerId) {
        state.audioEngine.setPeerVolume(state.activeContextPeerId, val / 100);
        updateUserVolumeTag(state.activeContextPeerId, val);
      }
    });

    el.btnContextMutePeer.addEventListener('click', () => {
      el.contextVolumeSlider.value = 0;
      el.contextVolumeLabel.textContent = '0%';
      if (state.activeContextPeerId) {
        state.audioEngine.setPeerVolume(state.activeContextPeerId, 0);
        updateUserVolumeTag(state.activeContextPeerId, 0);
      }
    });

    el.btnContextResetPeer.addEventListener('click', () => {
      el.contextVolumeSlider.value = 100;
      el.contextVolumeLabel.textContent = '100%';
      if (state.activeContextPeerId) {
        state.audioEngine.setPeerVolume(state.activeContextPeerId, 1.0);
        updateUserVolumeTag(state.activeContextPeerId, 100);
      }
    });
  }

  function openParticipantContextMenu(e, peer) {
    e.preventDefault();
    state.activeContextPeerId = peer.id;

    const currentVol = Math.round(state.audioEngine.getPeerVolume(peer.id) * 100);
    el.contextUserName.textContent = peer.username;
    el.contextUserAvatar.textContent = peer.username.charAt(0).toUpperCase();
    el.contextUserAvatar.style.backgroundColor = peer.avatarColor || '#3b82f6';
    el.contextVolumeSlider.value = currentVol;
    el.contextVolumeLabel.textContent = currentVol + '%';

    // Position popover
    let x = e.clientX;
    let y = e.clientY;
    if (x + 230 > window.innerWidth) x = window.innerWidth - 240;
    if (y + 160 > window.innerHeight) y = window.innerHeight - 170;

    el.participantContextMenu.style.left = x + 'px';
    el.participantContextMenu.style.top = y + 'px';
    el.participantContextMenu.classList.remove('hidden');
  }

  function updateUserVolumeTag(peerId, val) {
    const card = document.getElementById(`participant-card-${peerId}`);
    if (card) {
      let tag = card.querySelector('.participant-volume-tag');
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'participant-volume-tag';
        card.appendChild(tag);
      }
      tag.textContent = val !== 100 ? `Vol: ${val}%` : '';
    }
  }

  // ================= HOSTING: LOCAL SERVER + WORLDWIDE TUNNEL =================
  function setupHosting() {
    const api = window.electronAPI;
    if (!api || !api.hostStart) {
      el.hostPanel.classList.add('hidden');
      return;
    }

    const setStatus = (text, busy) => {
      el.hostStatusText.textContent = text || '';
      el.hostStatus.classList.toggle('hidden', !text);
      el.hostStatus.classList.toggle('busy', !!busy);
    };
    const showInvite = (code) => {
      state.inviteCode = code || '';
      el.hostInviteCode.textContent = state.inviteCode;
      el.hostInvite.classList.toggle('hidden', !state.inviteCode);
      el.btnNavInvite.classList.toggle('hidden', !state.inviteCode);
    };
    const setButtons = (running) => {
      el.btnHostOnline.disabled = el.btnHostLan.disabled = running;
      el.btnHostStop.classList.toggle('hidden', !running);
    };
    const copyInvite = () => {
      if (!state.inviteCode) return;
      navigator.clipboard.writeText(state.inviteCode)
        .then(() => toast('Invite code copied — send it to your friends', 'ok'))
        .catch(() => toast(state.inviteCode));
    };

    const start = async (online) => {
      setButtons(true);
      setStatus('Starting server…', true);
      const res = await api.hostStart(online);
      if (!res || !res.success) {
        setButtons(false);
        setStatus('');
        toast('Server error: ' + (res ? res.error : 'unknown'));
        return;
      }
      state.isLocalServerRunning = true;
      el.inputServerUrl.value = `http://127.0.0.1:${res.port}`;
      if (!online) {
        const lan = `${(res.ips && res.ips[0]) || '127.0.0.1'}:${res.port}`;
        setStatus('LAN server running — friends on your network join with:');
        showInvite(lan);
      }
    };

    api.onHostState((s) => {
      if (s.phase === 'preparing') setStatus(`Preparing secure tunnel… ${s.percent || 0}%`, true);
      else if (s.phase === 'connecting') setStatus('Connecting to the Cloudflare network…', true);
      else if (s.phase === 'online') {
        setStatus('Online worldwide — your invite code:');
        showInvite(s.code);
        toast('Your server is online', 'ok');
      } else if (s.phase === 'stopped' && !s.error) {
        showInvite('');
        setStatus('');
        setButtons(false);
        state.isLocalServerRunning = false;
      } else if (s.phase === 'error' || s.phase === 'stopped') {
        showInvite('');
        setStatus('Online tunnel unavailable: ' + (s.error || 'unknown error') + ' (the LAN server keeps running)');
        el.btnHostOnline.disabled = false;
      }
    });

    el.btnHostOnline.addEventListener('click', () => start(true));
    el.btnHostLan.addEventListener('click', () => start(false));
    el.btnCopyInvite.addEventListener('click', copyInvite);
    el.btnNavInvite.addEventListener('click', copyInvite);
    el.btnHostStop.addEventListener('click', async () => {
      await api.hostStop();
      state.isLocalServerRunning = false;
      setButtons(false);
      setStatus('');
      showInvite('');
    });
  }

  // ================= CONNECTION =================
  // Accepts an invite code (four-random-words), a full URL, a domain or an IP[:port]
  function normalizeServer(raw) {
    let s = String(raw || '').trim().replace(/\s+/g, '');
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) {
      if (/^[a-z0-9]+(-[a-z0-9]+){2,}$/i.test(s)) {
        s = `https://${s.toLowerCase()}.trycloudflare.com`;
      } else {
        const hostPart = s.split('/')[0];
        const local = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[^.:]+)(:\d+)?$/i.test(hostPart);
        s = (local ? 'http://' : 'https://') + (local && !/:\d+$/.test(hostPart) ? hostPart + ':3000' : hostPart);
      }
    }
    try { return new URL(s).origin; } catch (e) { return ''; }
  }

  function setConn(kind, text) {
    el.connectionBadge.dataset.state = kind;
    el.nodePingText.textContent = text;
  }

  function setLoginBusy(busy) {
    el.btnLoginSubmit.disabled = busy;
    el.btnLoginSubmit.textContent = busy ? 'Connecting…' : 'Join PelakaVoice';
  }

  function startPing() {
    clearInterval(state.pingTimer);
    const run = () => {
      const s = state.socket;
      if (!s || !s.connected) return;
      const t0 = performance.now();
      s.timeout(4000).emit('pv_ping', (err) => {
        if (!err && s.connected) setConn('ok', `Connected · ${Math.max(1, Math.round(performance.now() - t0))} ms`);
      });
    };
    run();
    state.pingTimer = setInterval(run, 15000);
  }

  // After an automatic reconnection the server sees us as a new socket: restore the session
  function resumeSession() {
    toast('Connection restored', 'ok');
    renderLobbies();
    if (state.pendingIncomingCall) {
      state.audioEngine.stopIncomingRingtone();
      el.modalIncomingCall.classList.add('hidden');
      state.pendingIncomingCall = null;
    }
    if (state.inDirectCall) {
      endDirectCallInternal();
      toast('The call ended because the connection dropped.');
    }
    if (!state.currentLobby) return;

    stopScreenSharing();
    state.webrtc.closeAll(true);
    state.lobbyPeers.clear();
    state.socket.emit('join_lobby', { lobbyId: state.currentLobby.id, password: state.lobbyPassword }, (res) => {
      if (!res || !res.success) {
        leaveLobby();
        toast('Could not rejoin the lobby after reconnecting.');
        return;
      }
      enterLobby(res, state.lobbyPassword, true);
      state.socket.emit('update_state', { isMuted: state.audioEngine.isMuted, isDeafened: state.audioEngine.isDeafened });
    });
  }

  function handleLogin() {
    const user = el.inputNickname.value.trim();
    const server = normalizeServer(el.inputServerUrl.value);

    if (!user) return showLoginError('Please enter a nickname.');
    if (!server) return showLoginError('Paste an invite code or a server address — or create your own server below.');

    state.username = user;
    state.serverUrl = server;
    el.inputServerUrl.value = server;
    localStorage.setItem('pv_nick', user);
    localStorage.setItem('pv_srv', server);

    el.loginError.classList.add('hidden');
    setLoginBusy(true);

    if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); }
    if (state.webrtc) state.webrtc.closeAll();
    clearInterval(state.pingTimer);
    state.loggedIn = false;

    let failures = 0;
    const socket = state.socket = io(server, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 700,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.3,
      timeout: 12000,
      transports: ['websocket', 'polling'],
      tryAllTransports: true
    });

    const failLogin = (msg) => {
      if (state.loggedIn || state.socket !== socket) return;
      clearTimeout(giveUp);
      socket.removeAllListeners();
      socket.disconnect();
      showLoginError(msg);
      setLoginBusy(false);
    };
    const unreachable = `Could not reach ${server}. Check the invite code and make sure the host's server is running.`;
    const giveUp = setTimeout(() => failLogin(unreachable), 16000);

    state.webrtc = new window.WebRTCManager(socket, state.audioEngine);
    if (window.pvFun) window.pvFun.attach(socket);

    state.webrtc.onRemoteScreenAdded = (peerId, stream) => { if (window.pvStage) window.pvStage.remoteVideo(peerId, stream); };
    state.webrtc.onRemoteScreenRemoved = (peerId) => { if (window.pvStage) window.pvStage.remoteVideoGone(peerId); };
    state.webrtc.onScreenStats = (peerId, s) => { if (window.pvStage) window.pvStage.stats(peerId, s); };
    if (window.pvStage) window.pvStage.attach(socket);

    socket.on('connect', () => {
      failures = 0;
      socket.emit('register_user', {
        username: state.username,
        tag: state.tag && state.tag.startsWith(state.username + '#') ? state.tag.split('#').pop() : null,
        avatarColor: state.avatarColor,
        friends: Array.from(state.friends.keys()),
        clientVersion: state.appVersion
      }, (res) => {
        if (!res || !res.success) return failLogin('Registration error: ' + (res ? res.error : 'unknown'));
        clearTimeout(giveUp);

        state.tag = res.user.tag;
        localStorage.setItem('pv_tag', state.tag);
        state.webrtc.setIceServers(res.iceServers);
        (res.friends || []).forEach(f => state.friends.set(f.tag, f));
        renderFriendsList();
        state.lobbies = res.lobbies || [];
        setConn('ok', 'Connected');
        startPing();

        if (state.loggedIn) return resumeSession();
        state.loggedIn = true;

        el.myTagText.textContent = state.tag;
        el.dockUsername.textContent = state.username;
        el.dockAvatarLetter.textContent = state.username.charAt(0).toUpperCase();
        el.dockAvatar.style.backgroundColor = state.avatarColor;

        el.loginScreen.classList.remove('active');
        el.appScreen.classList.add('active');
        setLoginBusy(false);

        state.lobbiesRendered = false;
        renderLobbies();
        if (window.electronAPI && window.electronAPI.setServer) window.electronAPI.setServer(server);
        if (window.pvStage) window.pvStage.onLogin(server);
      });
    });

    socket.on('disconnect', (reason) => {
      if (!state.loggedIn) return;
      setConn('warn', 'Reconnecting…');
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', () => {
      failures++;
      if (state.loggedIn) setConn('warn', 'Reconnecting…');
      else if (failures >= 4) failLogin(unreachable);
    });

    // Server broadcasts
    socket.on('lobbies_updated', (lobbies) => {
      state.lobbies = lobbies;
      renderLobbies();
      if (state.currentLobby) {
        const updated = lobbies.find(l => l.id === state.currentLobby.id);
        if (updated) {
          el.activeLobbyMeta.textContent = `${updated.userCount} participant${updated.userCount === 1 ? '' : 's'}`;
        }
      }
    });

    socket.on('lobby_user_joined', ({ user }) => {
      if (!state.currentLobby) return;
      state.audioEngine.playJoinSound();
      state.lobbyPeers.set(user.id, user);
      renderParticipants();
    });

    socket.on('lobby_user_left', ({ userId }) => {
      if (!state.currentLobby) return;
      state.audioEngine.playLeaveSound();
      state.webrtc.closePeer(userId);
      if (window.pvStage) window.pvStage.peerLeft(userId);
      state.lobbyPeers.delete(userId);
      renderParticipants();
    });

    socket.on('user_state_changed', ({ userId, state: peerState }) => {
      const peer = state.lobbyPeers.get(userId) || (state.directCallPartner && state.directCallPartner.id === userId ? state.directCallPartner : null);
      if (peer) {
        Object.assign(peer, peerState);
        updateParticipantCard(userId, peer);
      }
      if (window.pvStage) window.pvStage.peerState(userId, peerState);
    });

    // Friends
    socket.on('friend_updated', ({ friend }) => {
      state.friends.set(friend.tag, friend);
      saveFriends();
      renderFriendsList();
      if (state.selectedFriend && state.selectedFriend.tag === friend.tag) selectFriend(friend);
    });

    // Direct calls
    socket.on('incoming_direct_call', ({ callId, caller }) => {
      state.pendingIncomingCall = { callId, caller };
      state.audioEngine.startIncomingRingtone();
      el.incomingCallerName.textContent = caller.tag;
      el.modalIncomingCall.classList.remove('hidden');
    });

    socket.on('direct_call_cancelled', ({ callId }) => {
      if (!state.pendingIncomingCall || state.pendingIncomingCall.callId !== callId) return;
      state.audioEngine.stopIncomingRingtone();
      el.modalIncomingCall.classList.add('hidden');
      state.pendingIncomingCall = null;
      toast('Missed call');
    });

    socket.on('direct_call_accepted', async ({ callId, receiver }) => {
      state.inDirectCall = true;
      state.activeDirectCallId = callId;
      state.directCallPartner = receiver;
      try {
        const stream = await state.audioEngine.initLocalMicrophone(state.selectedMicDevice);
        state.webrtc.setLocalStream(stream);
        state.webrtc.callPeer(receiver.id);
        setupDirectCallActiveUI();
      } catch (e) {
        toast('Microphone error: ' + e.message);
        endDirectCall();
      }
    });

    socket.on('direct_call_declined', () => {
      toast('Call declined.');
      el.btnStartDirectCall.textContent = 'Call';
      el.btnStartDirectCall.disabled = false;
    });

    socket.on('direct_call_ended', () => {
      endDirectCallInternal();
    });

    socket.on('receive_direct_message', (msg) => {
      let tag = msg.senderTag;
      if (!tag) {
        const known = Array.from(state.friends.values()).find(f => f.id === msg.senderId);
        tag = known ? known.tag : msg.senderName;
      }
      let friend = state.friends.get(tag);
      if (!friend) {
        friend = { id: msg.senderId, tag, username: msg.senderName, avatarColor: '#8e8e93', status: 'online' };
        state.friends.set(tag, friend);
        saveFriends();
      } else {
        friend.id = msg.senderId;
        if (friend.status === 'offline') friend.status = 'online';
      }

      pushDm(tag, { author: msg.senderName, text: msg.text, mine: false, ts: msg.timestamp || Date.now() });
      state.audioEngine.playMessageSound();

      const reading = friendsTabActive() && state.selectedFriend && state.selectedFriend.tag === tag && document.hasFocus();
      if (!reading) {
        state.dmUnread.set(tag, unreadOf(tag) + 1);
        if (!friendsTabActive()) toast(`${msg.senderName}: ${msg.text.slice(0, 80)}`);
        if (!document.hasFocus() && window.electronAPI && window.electronAPI.flash) window.electronAPI.flash();
      }
      renderFriendsList();
    });

    // Lobby chat, soundboard, lobby deletion
    socket.on('lobby_chat', (m) => {
      if (state.currentLobby) appendLobbyChat(m);
    });

    socket.on('sounds_updated', ({ lobbyId, sounds }) => {
      if (state.currentLobby && state.currentLobby.id === lobbyId) setSounds(sounds);
    });

    socket.on('sound_play', ({ id }) => {
      if (!state.currentLobby) return;
      const s = state.sounds.find(x => x.id === id);
      flashSound(id, s ? s.duration : 5);
      state.soundboard.play(id, fetchSound).catch(() => {});
    });

    socket.on('lobby_deleted', ({ lobbyId }) => {
      if (state.armedDelete === lobbyId) state.armedDelete = null;
      if (!state.currentLobby || state.currentLobby.id !== lobbyId) return;
      const mine = state.currentLobby.creatorTag === state.tag;
      stopScreenSharing();
      state.audioEngine.playLeaveSound();
      state.webrtc.closeAll();
      state.audioEngine.stopLocalStream();
      exitLobbyUI();
      toast(mine ? 'Lobby deleted.' : 'This lobby was deleted by its creator.', mine ? 'ok' : '');
    });
  }

  function showLoginError(msg) {
    el.loginError.textContent = msg;
    el.loginError.classList.remove('hidden');
    el.loginError.classList.remove('shake');
    void el.loginError.offsetWidth;
    el.loginError.classList.add('shake');
  }

  // ================= LOBBIES =================
  function renderLobbies() {
    el.lobbiesGrid.innerHTML = '';
    el.lobbiesGrid.classList.toggle('stagger', !state.lobbiesRendered);
    state.lobbiesRendered = true;
    if (state.lobbies.length === 0) {
      el.lobbiesGrid.innerHTML = `
        <div class="empty-lobbies">
          <div class="empty-icon">${icon('wave')}</div>
          <h3>No lobbies yet</h3>
          <p>Create the first one — everyone on this server will see it.</p>
          <button type="button" class="btn-primary" id="btn-empty-create">Create lobby</button>
        </div>`;
      document.getElementById('btn-empty-create').addEventListener('click', openCreateLobbyModal);
      return;
    }

    state.lobbies.forEach(lobby => {
      const isCurrent = state.currentLobby && state.currentLobby.id === lobby.id;
      const mine = !!lobby.creatorTag && lobby.creatorTag === state.tag;
      const armed = state.armedDelete === lobby.id;
      const card = document.createElement('div');
      card.className = `lobby-card ${isCurrent ? 'active' : ''}`;

      let avatarsHtml = '';
      if (lobby.users && lobby.users.length > 0) {
        lobby.users.slice(0, 6).forEach(u => {
          avatarsHtml += `<div class="lobby-mini-avatar${u.isStreaming ? ' live' : ''}" style="background:${safeColor(u.avatarColor)}" title="${escapeHtml(u.tag)}">${escapeHtml((u.username || 'U').charAt(0).toUpperCase())}</div>`;
        });
      } else {
        avatarsHtml = '<span class="empty-lobby-text">Empty</span>';
      }

      card.innerHTML = `
        <div class="lobby-card-top">
          <div>
            <div class="lobby-card-title">${escapeHtml(lobby.name)}</div>
            <div class="lobby-card-author">${mine ? 'Created by you' : 'Created by ' + escapeHtml(lobby.creator || 'someone')}</div>
          </div>
          <span class="lobby-pill">${lobby.isPrivate ? icon('lock') + ' Private' : 'Public'} · ${lobby.userCount}/${lobby.maxUsers}</span>
        </div>
        <div class="lobby-members-preview">${avatarsHtml}</div>
        <div class="lobby-card-actions">
          <button type="button" class="btn-join-lobby">${isCurrent ? 'In this lobby' : (lobby.isPrivate && !mine ? 'Unlock & join' : 'Join voice')}</button>
          ${mine ? `<button type="button" class="btn-icon-danger ${armed ? 'armed' : ''}" title="Delete lobby">${armed ? '<span>Delete?</span>' : icon('trash')}</button>` : ''}
        </div>`;

      card.querySelector('.btn-join-lobby').addEventListener('click', () => {
        if (isCurrent) {
          el.lobbiesBrowserView.classList.remove('active');
          el.activeLobbyStage.classList.add('active');
        } else if (mine) {
          joinLobby(lobby.id, ''); // the creator never needs the password
        } else {
          requestJoinLobby(lobby);
        }
      });
      const del = card.querySelector('.btn-icon-danger');
      if (del) del.addEventListener('click', () => confirmDelete(lobby.id));

      el.lobbiesGrid.appendChild(card);
    });
  }

  // Two-step delete: the first click arms the button, a second click within 3 s deletes
  function confirmDelete(lobbyId) {
    if (state.armedDelete !== lobbyId) {
      state.armedDelete = lobbyId;
      clearTimeout(state.armedTimer);
      state.armedTimer = setTimeout(() => {
        state.armedDelete = null;
        renderLobbies();
        syncDeleteBtn();
      }, 3000);
    } else {
      clearTimeout(state.armedTimer);
      state.armedDelete = null;
      const inside = state.currentLobby && state.currentLobby.id === lobbyId;
      state.socket.emit('delete_lobby', { lobbyId }, (res) => {
        if (!res || !res.success) toast((res && res.error) || 'Could not delete the lobby.');
        else if (!inside) toast('Lobby deleted.', 'ok');
      });
    }
    renderLobbies();
    syncDeleteBtn();
  }

  function syncDeleteBtn() {
    const lobby = state.currentLobby;
    const mine = !!lobby && lobby.creatorTag === state.tag;
    el.btnDeleteLobby.classList.toggle('hidden', !mine);
    el.btnDeleteLobby.textContent = mine && state.armedDelete === lobby.id ? 'Click again to delete' : 'Delete lobby';
  }

  function requestJoinLobby(lobby) {
    if (lobby.isPrivate) {
      state.pendingJoinLobbyId = lobby.id;
      el.passcodeModalDesc.textContent = `Enter password for "${lobby.name}":`;
      el.inputEnterPasscode.value = '';
      el.enterPasscodeError.classList.add('hidden');
      el.modalEnterPasscode.classList.remove('hidden');
      setTimeout(() => el.inputEnterPasscode.focus(), 100);
      return;
    }
    joinLobby(lobby.id, '');
  }

  function handleJoinPrivateLobby() {
    const code = el.inputEnterPasscode.value.trim();
    if (!state.pendingJoinLobbyId) return;

    joinLobby(state.pendingJoinLobbyId, code, (err) => {
      if (err) {
        el.enterPasscodeError.textContent = err;
        el.enterPasscodeError.classList.remove('hidden');
      } else {
        el.modalEnterPasscode.classList.add('hidden');
        state.pendingJoinLobbyId = null;
      }
    });
  }

  async function joinLobby(lobbyId, password = '', errorCb = null) {
    try {
      if (state.inDirectCall) endDirectCall();

      const stream = await state.audioEngine.initLocalMicrophone(state.selectedMicDevice);
      state.webrtc.setLocalStream(stream);

      state.socket.emit('join_lobby', { lobbyId, password }, (res) => {
        if (!res || !res.success) {
          const err = res ? res.error : 'Failed to join';
          if (!state.currentLobby) state.audioEngine.stopLocalStream(); // don't keep the mic open
          if (errorCb) errorCb(err);
          else toast(err);
          return;
        }
        if (errorCb) errorCb(null);
        enterLobby(res, password);
      });
    } catch (e) {
      toast('Microphone error: ' + e.message);
      if (errorCb) errorCb(e.message);
    }
  }

  function participantsLabel(n) {
    return `${n} participant${n === 1 ? '' : 's'}`;
  }

  // Called after a successful join (also when switching lobby or rejoining after a reconnect)
  function enterLobby(res, password, silent) {
    if (state.currentLobby) {
      stopScreenSharing();
      state.webrtc.closeAll(true); // drop the connections of the previous lobby
      state.soundboard.stopAll();
    }
    state.currentLobby = res.lobby;
    state.lobbyPassword = password;
    state.lobbyPeers.clear();
    (res.peers || []).forEach(peer => {
      state.lobbyPeers.set(peer.id, peer);
      state.webrtc.callPeer(peer.id);
    });

    if (!silent) state.audioEngine.playJoinSound();

    el.activeLobbyIcon.innerHTML = icon(res.lobby.isPrivate ? 'lock' : 'wave');
    el.activeLobbyTitle.textContent = res.lobby.name;
    el.activeLobbyMeta.textContent = participantsLabel((res.peers || []).length + 1);
    el.dockChannelName.textContent = res.lobby.name;
    el.dockBtnDisengage.classList.remove('hidden');
    syncDeleteBtn();

    state.lobbyChat = res.chat || [];
    renderLobbyChat();
    setSounds(res.sounds || []);

    el.lobbiesBrowserView.classList.remove('active');
    el.activeLobbyStage.classList.add('active');
    renderParticipants();
    renderLobbies();
    if (window.pvStage) window.pvStage.onEnterLobby(res.peers || []);
  }

  function leaveLobby() {
    if (!state.currentLobby) return;
    stopScreenSharing();
    state.audioEngine.playLeaveSound();
    state.webrtc.closeAll();
    state.audioEngine.stopLocalStream();
    if (state.socket) state.socket.emit('leave_lobby');
    exitLobbyUI();
  }

  function exitLobbyUI() {
    if (window.pvStage) window.pvStage.onExit();
    state.currentLobby = null;
    state.lobbyPeers.clear();
    state.lobbyChat = [];
    renderLobbyChat();
    state.soundboard.stopAll();
    setSounds([]);
    syncDeleteBtn();

    el.dockChannelName.textContent = 'Not in call';
    el.dockBtnDisengage.classList.add('hidden');
    el.screenShareContainer.classList.add('hidden');
    el.activeLobbyStage.classList.remove('active');
    el.lobbiesBrowserView.classList.add('active');
    renderLobbies();
  }

  function renderParticipants() {
    el.participantsGrid.innerHTML = '';

    // Self card
    const selfCard = document.createElement('div');
    selfCard.className = `participant-card ${state.audioEngine.isSpeaking ? 'speaking' : ''}${state.isSharingScreen ? ' live' : ''}`;
    selfCard.id = 'participant-card-self';
    selfCard.innerHTML = `
      <div class="participant-avatar-wrap" style="background:${state.avatarColor}">
        ${state.username.charAt(0).toUpperCase()}
        ${state.audioEngine.isMuted ? `<span class="card-mute-badge">${icon('mic-off')}</span>` : ''}
      </div>
      <div class="participant-name-tag">${escapeHtml(state.username)} (You)</div>
    `;
    el.participantsGrid.appendChild(selfCard);

    // Peers cards (Right-clickable for volume!)
    state.lobbyPeers.forEach(peer => {
      const card = document.createElement('div');
      card.className = `participant-card ${peer.isSpeaking ? 'speaking' : ''}${peer.isStreaming ? ' live' : ''}`;
      card.id = `participant-card-${peer.id}`;
      card.innerHTML = `
        <div class="participant-avatar-wrap" style="background:${peer.avatarColor || '#3b82f6'}">
          ${(peer.username || 'U').charAt(0).toUpperCase()}
          ${peer.isMuted ? `<span class="card-mute-badge">${icon('mic-off')}</span>` : ''}
        </div>
        <div class="participant-name-tag">${escapeHtml(peer.username)}</div>
      `;

      // Right-click listener to adjust user volume
      card.addEventListener('contextmenu', (e) => {
        openParticipantContextMenu(e, peer);
      });

      el.participantsGrid.appendChild(card);
    });
  }

  function updateParticipantCard(peerId, peer) {
    const card = document.getElementById(`participant-card-${peerId}`);
    if (!card) return;

    card.classList.toggle('speaking', !!peer.isSpeaking);
    card.classList.toggle('live', !!peer.isStreaming);

    const badge = card.querySelector('.card-mute-badge');
    if (peer.isMuted) {
      if (!badge) {
        const span = document.createElement('span');
        span.className = 'card-mute-badge';
        span.innerHTML = icon('mic-off');
        card.querySelector('.participant-avatar-wrap').appendChild(span);
      }
    } else {
      if (badge) badge.remove();
    }
  }

  function openCreateLobbyModal() {
    el.createPodName.value = '';
    el.createPodPrivate.checked = false;
    el.podPasscodeGroup.classList.add('hidden');
    el.createPodPasscode.value = '';
    el.createPodError.classList.add('hidden');
    el.modalCreatePod.classList.remove('hidden');
    setTimeout(() => el.createPodName.focus(), 100);
  }

  function handleCreateLobby() {
    const name = el.createPodName.value.trim();
    const capacity = parseInt(el.createPodCapacity.value, 10) || 8;
    const isPrivate = el.createPodPrivate.checked;
    const password = isPrivate ? el.createPodPasscode.value.trim() : '';

    if (!name) {
      el.createPodError.textContent = 'Please enter a lobby name.';
      el.createPodError.classList.remove('hidden');
      return;
    }

    state.socket.emit('create_lobby', { name, maxUsers: capacity, isPrivate, password }, (res) => {
      if (res && res.success) {
        el.modalCreatePod.classList.add('hidden');
        joinLobby(res.lobbyId, password);
      } else {
        el.createPodError.textContent = res ? res.error : 'Creation error';
        el.createPodError.classList.remove('hidden');
      }
    });
  }

  // ================= SCREEN SHARING =================
  async function toggleScreenShare() {
    if (state.isSharingScreen) {
      stopScreenSharing();
      return;
    }

    // Must be in call or lobby
    if (!state.currentLobby && !state.inDirectCall) {
      toast('Join a lobby or start a call before going live.');
      return;
    }

    try {
      if (window.electronAPI && window.electronAPI.getScreenSources) {
        // Show clean window/screen picker modal
        const sources = await window.electronAPI.getScreenSources();
        renderScreenSourcesPicker(sources);
      } else {
        // Browser fallback
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        startSharingStream(stream);
      }
    } catch (err) {
      console.error('Screen sharing initiation error:', err);
    }
  }

  // Capture + encoding profiles. 'motion' keeps the frame rate under pressure, 'detail' keeps text sharp.
  const SCREEN_PROFILES = {
    '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 8000000, hint: 'motion' },
    '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 4500000, hint: 'detail' },
    '720p60': { w: 1280, h: 720, fps: 60, bitrate: 4000000, hint: 'motion' }
  };

  function renderScreenSourcesPicker(sources) {
    el.screenSourcesGrid.innerHTML = '';
    el.qualityBtns.forEach(b => b.classList.toggle('active', b.dataset.q === state.screenQuality));

    sources.forEach(src => {
      const item = document.createElement('div');
      item.className = 'screen-source-item';
      item.innerHTML = `
        <img src="${src.thumbnail}" class="source-thumbnail" alt="">
        <span class="source-title"></span>
      `;
      item.querySelector('.source-title').textContent = src.name;
      item.querySelector('.source-title').title = src.name;

      item.addEventListener('click', async () => {
        el.modalScreenPicker.classList.add('hidden');
        const prof = Object.assign({}, SCREEN_PROFILES[state.screenQuality] || SCREEN_PROFILES['1080p60']);
        const withAudio = !!(document.getElementById('check-share-audio') || {}).checked;
        const capture = async (fps, audio) => {
          if (window.electronAPI && window.electronAPI.selectCapture) {
            await window.electronAPI.selectCapture(src.id, audio);
            return navigator.mediaDevices.getDisplayMedia({
              audio,
              video: { width: { ideal: prof.w, max: prof.w }, height: { ideal: prof.h, max: prof.h }, frameRate: { ideal: fps, max: fps } }
            });
          }
          return navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: prof.w, maxHeight: prof.h, maxFrameRate: fps } }
          });
        };
        try {
          let stream;
          try {
            stream = await capture(prof.fps, withAudio);
          } catch (e) {
            try {
              stream = await capture(prof.fps, false); // sound capture not available (Windows older than 10 2004)
              if (withAudio) toast('Sound could not be captured on this PC — streaming video only.');
            } catch (e2) {
              if (prof.fps <= 30) throw e2;
              stream = await capture(30, false); // some GPUs/drivers refuse 60 fps capture
              prof.fps = 30;
              toast('60 fps capture is not available on this PC — streaming at 30 fps.');
            }
          }
          if (!state.currentLobby && !state.inDirectCall) {
            stream.getTracks().forEach(t => t.stop());
            return;
          }
          startSharingStream(stream, prof);
        } catch (e) {
          toast('Screen capture failed: ' + e.message);
        }
      });

      el.screenSourcesGrid.appendChild(item);
    });

    el.modalScreenPicker.classList.remove('hidden');
  }

  async function startSharingStream(stream, prof) {
    state.isSharingScreen = true;
    state.localScreenStream = stream;
    el.dockBtnScreen.classList.add('sharing');
    el.dockScreenLabel.textContent = 'Stop streaming';
    await state.webrtc.startScreenShare(stream, prof);
    if (window.pvStage) window.pvStage.local(stream, prof);
    const selfCard = document.getElementById('participant-card-self');
    if (selfCard) selfCard.classList.add('live');
    stream.getVideoTracks()[0].onended = () => stopScreenSharing(); // stopped from the Windows bar
  }

  function stopScreenSharing() {
    if (!state.isSharingScreen) return;
    state.isSharingScreen = false;
    el.dockBtnScreen.classList.remove('sharing');
    el.dockScreenLabel.textContent = 'Go live';
    state.webrtc.stopScreenShare();
    if (state.localScreenStream) {
      state.localScreenStream.getTracks().forEach(t => t.stop());
      state.localScreenStream = null;
    }
    if (window.pvStage) window.pvStage.localStop();
    const selfCard = document.getElementById('participant-card-self');
    if (selfCard) selfCard.classList.remove('live');
  }

  // ================= FRIENDS & DIRECT COMMS =================
  function handleAddFriend() {
    const tag = el.inputAddFriendTag.value.trim();
    if (!tag) return;

    state.socket.emit('add_friend', { tag }, (res) => {
      if (res && res.success) {
        el.addFriendError.classList.add('hidden');
        el.inputAddFriendTag.value = '';
        state.friends.set(res.friend.tag, res.friend);
        saveFriends();
        renderFriendsList();
        selectFriend(res.friend);
      } else {
        el.addFriendError.textContent = res ? res.error : 'Failed to add friend';
        el.addFriendError.classList.remove('hidden');
      }
    });
  }

  function friendsTabActive() {
    return document.getElementById('tab-friends').classList.contains('active');
  }

  function unreadOf(tag) {
    return state.dmUnread.get(tag) || 0;
  }

  function renderFriendsList() {
    el.friendsList.innerHTML = '';
    updateDmBadge();
    if (state.friends.size === 0) {
      el.friendsList.innerHTML = '<div class="friends-empty">No friends yet. Add someone with their tag.</div>';
      return;
    }

    const offline = (f) => (!f.id || f.status === 'offline' ? 1 : 0);
    const list = Array.from(state.friends.values()).sort((a, b) =>
      (unreadOf(b.tag) - unreadOf(a.tag)) || (offline(a) - offline(b)) || a.username.localeCompare(b.username));

    list.forEach(friend => {
      const n = unreadOf(friend.tag);
      const status = friend.id ? (friend.status || 'online') : 'offline';
      const selected = state.selectedFriend && state.selectedFriend.tag === friend.tag;
      const row = document.createElement('div');
      row.className = `friend-row${selected ? ' active' : ''}${n ? ' unread' : ''}`;
      row.innerHTML = `
        <div class="friend-row-avatar" style="background:${safeColor(friend.avatarColor)}">
          ${escapeHtml(friend.username.charAt(0).toUpperCase())}<span class="presence ${status}"></span>
        </div>
        <div class="friend-row-text">
          <div class="friend-row-name">${escapeHtml(friend.username)}</div>
          <div class="friend-row-status ${status}">${statusLabel(status)}</div>
        </div>
        ${n ? `<span class="count-badge">+${n > 99 ? 99 : n}</span>` : ''}
      `;
      row.addEventListener('click', () => selectFriend(friend));
      el.friendsList.appendChild(row);
    });
  }

  // "+N" on the Friends & DMs tab = total unread direct messages
  function updateDmBadge() {
    let total = 0;
    state.dmUnread.forEach(n => { total += n; });
    el.badgeIncomingMsg.textContent = '+' + (total > 99 ? 99 : total);
    el.badgeIncomingMsg.classList.toggle('hidden', total === 0);
  }

  function markRead(tag) {
    if (!state.dmUnread.has(tag)) return;
    state.dmUnread.delete(tag);
    renderFriendsList();
  }

  function selectFriend(friend) {
    const changed = !state.selectedFriend || state.selectedFriend.tag !== friend.tag;
    state.selectedFriend = friend;
    if (friendsTabActive()) state.dmUnread.delete(friend.tag);
    renderFriendsList();

    el.directEmptyState.classList.add('hidden');
    el.directActiveState.classList.remove('hidden');

    const status = friend.id ? (friend.status || 'online') : 'offline';
    el.directTargetAvatar.textContent = friend.username.charAt(0).toUpperCase();
    el.directTargetAvatar.style.backgroundColor = safeColor(friend.avatarColor);
    el.directTargetName.textContent = friend.tag;
    el.directTargetStatus.textContent = statusLabel(status);
    el.directTargetStatus.className = 'user-status-text ' + status;
    if (changed) {
      el.directChatMessages.innerHTML = '';
      (state.dms.get(friend.tag) || []).forEach(appendChatMessage);
    }
  }

  function startDirectCall() {
    if (!state.selectedFriend) return;
    if (!state.selectedFriend.id || state.selectedFriend.status === 'offline') {
      toast(`${state.selectedFriend.username} is offline right now.`);
      return;
    }

    el.btnStartDirectCall.textContent = 'Calling…';
    el.btnStartDirectCall.disabled = true;

    state.socket.emit('start_direct_call', {
      targetSocketId: state.selectedFriend.id
    }, (res) => {
      if (!res || !res.success) {
        toast(res ? res.error : 'Friend unreachable');
        el.btnStartDirectCall.textContent = 'Call';
        el.btnStartDirectCall.disabled = false;
      }
    });
  }

  function acceptIncomingCall() {
    if (!state.pendingIncomingCall) return;
    state.audioEngine.stopIncomingRingtone();
    el.modalIncomingCall.classList.add('hidden');

    const call = state.pendingIncomingCall;
    state.pendingIncomingCall = null;

    state.inDirectCall = true;
    state.activeDirectCallId = call.callId;
    state.directCallPartner = call.caller;

    state.socket.emit('respond_direct_call', { callId: call.callId, accept: true });

    state.audioEngine.initLocalMicrophone(state.selectedMicDevice).then(stream => {
      state.webrtc.setLocalStream(stream);
      setupDirectCallActiveUI();
    }).catch(e => {
      toast('Mic error: ' + e.message);
    });
  }

  function declineIncomingCall() {
    if (!state.pendingIncomingCall) return;
    state.audioEngine.stopIncomingRingtone();
    el.modalIncomingCall.classList.add('hidden');
    state.socket.emit('respond_direct_call', { callId: state.pendingIncomingCall.callId, accept: false });
    state.pendingIncomingCall = null;
  }

  function setupDirectCallActiveUI() {
    if (window.pvStage) window.pvStage.onDirectCall(state.directCallPartner);
    el.btnStartDirectCall.classList.add('hidden');
    el.btnEndDirectCall.classList.remove('hidden');
    el.directCallActiveBanner.classList.remove('hidden');

    el.dockChannelName.textContent = `Call: ${state.directCallPartner.username}`;
    el.dockBtnDisengage.classList.remove('hidden');
  }

  function endDirectCall() {
    if (!state.inDirectCall) return;

    stopScreenSharing();

    if (state.socket) {
      state.socket.emit('end_direct_call', {
        callId: state.activeDirectCallId,
        targetSocketId: state.directCallPartner ? state.directCallPartner.id : null
      });
    }
    endDirectCallInternal();
  }

  function endDirectCallInternal() {
    if (window.pvStage) window.pvStage.onExit();
    stopScreenSharing();
    state.audioEngine.playLeaveSound();
    state.webrtc.closeAll();
    state.audioEngine.stopLocalStream();

    state.inDirectCall = false;
    state.activeDirectCallId = null;
    state.directCallPartner = null;

    el.btnStartDirectCall.classList.remove('hidden');
    el.btnStartDirectCall.disabled = false;
    el.btnStartDirectCall.textContent = 'Call';
    el.btnEndDirectCall.classList.add('hidden');
    el.directCallActiveBanner.classList.add('hidden');
    el.directScreenContainer.classList.add('hidden');

    el.dockChannelName.textContent = 'Not in call';
    el.dockBtnDisengage.classList.add('hidden');
  }

  function sendDirectMessage() {
    const friend = state.selectedFriend;
    if (!friend || !state.socket) return;
    const text = el.inputDirectChat.value.trim();
    if (!text) return;
    if (!friend.id) { toast(`${friend.username} is offline right now.`); return; }

    el.inputDirectChat.value = '';
    state.socket.emit('send_direct_message', { targetSocketId: friend.id, text }, (res) => {
      if (res && res.success) {
        pushDm(friend.tag, { author: state.username, text, mine: true, ts: Date.now() });
      } else {
        toast((res && res.error) || 'Message not delivered.');
        if (!el.inputDirectChat.value) el.inputDirectChat.value = text;
      }
    });
  }

  // Each friend keeps their own conversation (until the app is closed)
  function pushDm(tag, m) {
    let list = state.dms.get(tag);
    if (!list) state.dms.set(tag, list = []);
    list.push(m);
    if (list.length > 200) list.shift();
    if (state.selectedFriend && state.selectedFriend.tag === tag) appendChatMessage(m);
  }

  function appendChatMessage(m) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${m.mine ? 'mine' : 'theirs'}`;
    bubble.innerHTML = '<div class="chat-bubble-author"></div><div class="chat-bubble-text"></div>';
    bubble.firstChild.textContent = `${m.author} · ${fmtTime(m.ts)}`;
    if (window.pvFun) window.pvFun.fillText(bubble.lastChild, m.text);
    else bubble.lastChild.textContent = m.text;
    el.directChatMessages.appendChild(bubble);
    el.directChatMessages.scrollTop = el.directChatMessages.scrollHeight;
  }

  // ================= DOCK ACTIONS =================
  function toggleMute() {
    const muted = state.audioEngine.toggleMute();
    if (muted) {
      el.dockBtnMute.classList.add('active');
      el.dockMuteLabel.textContent = 'Muted';
    } else {
      el.dockBtnMute.classList.remove('active');
      el.dockMuteLabel.textContent = 'Mute';
    }
    renderParticipants();

    if (state.socket) {
      state.socket.emit('update_state', {
        isMuted: muted,
        targetCallPeer: state.inDirectCall && state.directCallPartner ? state.directCallPartner.id : null
      });
    }
  }

  function toggleDeafen() {
    const deafened = state.audioEngine.toggleDeafen();
    if (deafened) {
      el.dockBtnDeafen.classList.add('active');
      el.dockDeafenLabel.textContent = 'Deafened';
      el.dockBtnMute.classList.add('active');
      el.dockMuteLabel.textContent = 'Muted';
    } else {
      el.dockBtnDeafen.classList.remove('active');
      el.dockDeafenLabel.textContent = 'Deafen';
    }
    renderParticipants();

    if (state.socket) {
      state.socket.emit('update_state', {
        isDeafened: deafened,
        isMuted: true,
        targetCallPeer: state.inDirectCall && state.directCallPartner ? state.directCallPartner.id : null
      });
    }
  }

  async function populateAudioInputDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');

      el.selectMicDevice.innerHTML = '<option value="">Default System Microphone</option>';
      audioInputs.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${idx + 1}`;
        el.selectMicDevice.appendChild(opt);
      });

      const savedMic = localStorage.getItem('pv_mic') || '';
      if (audioInputs.some(d => d.deviceId === savedMic)) {
        el.selectMicDevice.value = savedMic;
        state.selectedMicDevice = savedMic;
      }
      el.selectMicDevice.onchange = () => {
        state.selectedMicDevice = el.selectMicDevice.value;
        localStorage.setItem('pv_mic', state.selectedMicDevice);
        if (state.currentLobby || state.inDirectCall) {
          state.audioEngine.initLocalMicrophone(state.selectedMicDevice).then(stream => {
            state.webrtc.setLocalStream(stream);
          });
        }
      };
    } catch (e) {}
  }

  // ================= IN-APP UPDATES (background download, restart when ready) =================
  function setupAutoUpdater() {
    const api = window.electronAPI;
    if (api && api.getAppVersion) {
      api.getAppVersion().then((v) => {
        state.appVersion = v || '';
        el.appVersionText.textContent = 'PelakaVoice ' + state.appVersion;
      });
    }
    if (!api || !api.onUpdateState) {
      el.btnCheckUpdate.classList.add('hidden');
      return;
    }

    let manual = false;
    let announced = false;
    const render = (s) => {
      if (!s) return;
      if (s.phase === 'downloading') {
        el.updatePill.classList.remove('hidden', 'ready');
        el.updatePill.disabled = true;
        el.updatePillText.textContent = `Updating… ${s.percent || 0}%`;
      } else if (s.phase === 'ready') {
        el.updatePill.classList.remove('hidden');
        el.updatePill.classList.add('ready');
        el.updatePill.disabled = false;
        el.updatePillText.textContent = `Restart to update${s.version ? ' · ' + s.version : ''}`;
        if (!announced) {
          announced = true;
          document.getElementById('update-ready-version').textContent = s.version ? `Version ${s.version}` : '';
          document.getElementById('update-ready-notes').textContent = s.notes || 'A new version of PelakaVoice has been downloaded. Restart to install it — it takes a few seconds.';
          document.getElementById('modal-update-ready').classList.remove('hidden');
        }
      } else if (s.phase === 'installing') {
        el.updatePill.disabled = true;
        el.updatePillText.textContent = 'Restarting…';
      } else if (s.phase === 'none' || s.phase === 'error') {
        el.updatePill.classList.add('hidden');
        if (manual) {
          manual = false;
          toast(s.phase === 'error' ? 'Update failed: ' + s.error : (s.dev ? 'Updates are disabled in development mode.' : 'You are on the latest version.'), s.phase === 'error' ? '' : 'ok');
        }
      }
    };

    api.onUpdateState(render);
    api.getUpdateState().then(render);
    el.updatePill.addEventListener('click', () => api.installUpdate());
    document.getElementById('btn-update-restart').addEventListener('click', () => api.installUpdate());
    el.btnCheckUpdate.addEventListener('click', () => { manual = true; api.checkUpdate(); });
  }

  // ================= THEMES =================
  function setupThemes() {
    const cards = document.querySelectorAll('.theme-card');
    const apply = (name) => {
      document.documentElement.dataset.theme = name;
      localStorage.setItem('pv_theme', name);
      cards.forEach(c => c.classList.toggle('active', c.dataset.theme === name));
      if (window.electronAPI && window.electronAPI.setTheme) window.electronAPI.setTheme(name);
    };
    cards.forEach(card => card.addEventListener('click', (e) => {
      const name = card.dataset.theme;
      if (name === document.documentElement.dataset.theme) return;
      document.documentElement.style.setProperty('--vt-x', e.clientX + 'px');
      document.documentElement.style.setProperty('--vt-y', e.clientY + 'px');
      if (document.startViewTransition) document.startViewTransition(() => apply(name));
      else apply(name);
    }));
    apply(document.documentElement.dataset.theme || 'nova');
  }

  // ================= SMALL HELPERS =================
  function toast(message, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = String(message);
    el.toastStack.appendChild(t);
    while (el.toastStack.children.length > 4) el.toastStack.firstChild.remove();
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 280);
    }, 4200);
  }

  function statusLabel(status) {
    return { online: 'Online', in_lobby: 'In a lobby', in_call: 'In a call', offline: 'Offline' }[status || 'online'] || 'Online';
  }

  function loadFriends() {
    try {
      JSON.parse(localStorage.getItem('pv_friends') || '[]').forEach((tag) => {
        if (typeof tag === 'string' && tag.includes('#')) {
          state.friends.set(tag, { id: null, tag, username: tag.split('#')[0], avatarColor: '#8e8e93', status: 'offline' });
        }
      });
    } catch (e) {}
  }

  function saveFriends() {
    localStorage.setItem('pv_friends', JSON.stringify(Array.from(state.friends.keys())));
  }

  // ================= LOBBY CHAT + SOUNDBOARD =================
  function setupLobbyExtras() {
    el.btnSendLobbyChat.addEventListener('click', sendLobbyChat);
    el.inputLobbyChat.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLobbyChat(); });
    el.btnDeleteLobby.addEventListener('click', () => { if (state.currentLobby) confirmDelete(state.currentLobby.id); });

    el.qualityBtns.forEach(b => b.addEventListener('click', () => {
      state.screenQuality = b.dataset.q;
      localStorage.setItem('pv_sq', state.screenQuality);
      el.qualityBtns.forEach(x => x.classList.toggle('active', x === b));
    }));

    // Reading a conversation after coming back to the window clears its "+N"
    window.addEventListener('focus', () => {
      if (friendsTabActive() && state.selectedFriend) markRead(state.selectedFriend.tag);
    });

    setupSoundboard();
    renderLobbyChat();
    renderSounds();
  }

  function renderLobbyChat() {
    el.lobbyChatList.innerHTML = '';
    if (!state.lobbyChat.length) {
      el.lobbyChatList.innerHTML = '<div class="chat-empty">No messages yet. Say hi!</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    state.lobbyChat.forEach((m, i) => frag.appendChild(lobbyMsgEl(m, state.lobbyChat[i - 1])));
    el.lobbyChatList.appendChild(frag);
    el.lobbyChatList.scrollTop = el.lobbyChatList.scrollHeight;
  }

  function lobbyMsgEl(m, prev) {
    if (m.kind && m.kind !== 'text' && window.pvFun) return window.pvFun.renderMsg(m);
    const grouped = prev && (!prev.kind || prev.kind === 'text') && prev.senderTag === m.senderTag && m.ts - prev.ts < 120000;
    const row = document.createElement('div');
    row.className = 'lchat-msg' + (grouped ? ' grouped' : '') + (m.senderTag === state.tag ? ' mine' : '');
    row.innerHTML = grouped
      ? '<div class="lchat-text"></div>'
      : `<div class="lchat-avatar" style="background:${safeColor(m.avatarColor)}">${escapeHtml((m.senderName || '?').charAt(0).toUpperCase())}</div>
         <div class="lchat-body"><div class="lchat-head"><strong></strong><span>${fmtTime(m.ts)}</span></div><div class="lchat-text"></div></div>`;
    if (!grouped) row.querySelector('strong').textContent = m.senderName;
    const textEl = row.querySelector('.lchat-text');
    if (window.pvFun) window.pvFun.fillText(textEl, m.text);
    else textEl.textContent = m.text;
    if (window.pvFun && window.pvFun.mentionsMe(m)) row.classList.add('mention');
    return row;
  }

  function appendLobbyChat(m) {
    const prev = state.lobbyChat[state.lobbyChat.length - 1];
    state.lobbyChat.push(m);
    if (state.lobbyChat.length > 100) state.lobbyChat.shift();
    const empty = el.lobbyChatList.querySelector('.chat-empty');
    if (empty) empty.remove();
    const list = el.lobbyChatList;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.appendChild(lobbyMsgEl(m, prev));
    while (list.children.length > 100) list.firstChild.remove();
    if (nearBottom || m.senderTag === state.tag) list.scrollTop = list.scrollHeight;
  }

  function sendLobbyChat() {
    const text = el.inputLobbyChat.value.trim();
    if (!text || !state.currentLobby || !state.socket) return;
    el.inputLobbyChat.value = '';
    state.socket.emit('lobby_chat_send', { text }, (res) => {
      if (!res || !res.success) {
        toast((res && res.error) || 'Message not sent.');
        if (!el.inputLobbyChat.value) el.inputLobbyChat.value = text;
      }
    });
  }

  function setupSoundboard() {
    const sb = state.soundboard;
    el.sliderSbVolume.value = Math.round(sb.volume * 100);
    const showVol = () => { el.sbVolumeLabel.textContent = el.sliderSbVolume.value + '%'; };
    showVol();
    el.sliderSbVolume.addEventListener('input', () => { sb.setVolume(el.sliderSbVolume.value / 100); showVol(); });
    el.btnSbStop.addEventListener('click', () => sb.stopAll());

    if (!window.Soundboard.supported()) {
      el.btnAddSound.disabled = true;
      el.btnAddSound.title = 'Sound uploads are not supported on this system';
    }
    el.btnAddSound.addEventListener('click', openAddSound);
    el.inputSoundFile.addEventListener('change', () => loadSoundFile(el.inputSoundFile.files[0]));
    el.soundDrop.addEventListener('dragover', (e) => { e.preventDefault(); el.soundDrop.classList.add('over'); });
    el.soundDrop.addEventListener('dragleave', () => el.soundDrop.classList.remove('over'));
    el.soundDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      el.soundDrop.classList.remove('over');
      loadSoundFile(e.dataTransfer.files[0]);
    });
    el.soundLenBtns.forEach(b => b.addEventListener('click', () => {
      state.upload.length = parseInt(b.dataset.len, 10);
      el.soundLenBtns.forEach(x => x.classList.toggle('active', x === b));
      updateTrimUI();
    }));
    el.sliderSoundStart.addEventListener('input', updateTrimUI);
    el.btnPreviewSound.addEventListener('click', previewUpload);
    el.btnSubmitSound.addEventListener('click', submitSound);
    el.modalAddSound.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', stopPreview));
  }

  function soundError(msg) {
    el.addSoundError.textContent = msg;
    el.addSoundError.classList.remove('hidden');
  }

  function openAddSound() {
    if (!state.currentLobby) return;
    stopPreview();
    state.upload = { buffer: null, length: state.upload ? state.upload.length : 5, preview: null };
    el.inputSoundFile.value = '';
    el.inputSoundName.value = '';
    el.soundFileLabel.textContent = 'Choose an .mp3 or drop it here';
    el.soundTrimBox.classList.add('hidden');
    el.addSoundError.classList.add('hidden');
    el.btnSubmitSound.disabled = true;
    el.btnSubmitSound.textContent = 'Upload';
    el.soundLenBtns.forEach(x => x.classList.toggle('active', parseInt(x.dataset.len, 10) === state.upload.length));
    el.modalAddSound.classList.remove('hidden');
  }

  async function loadSoundFile(file) {
    if (!file || !state.upload) return;
    stopPreview();
    el.addSoundError.classList.add('hidden');
    if (!/\.mp3$/i.test(file.name) && file.type !== 'audio/mpeg') return soundError('Please choose an .mp3 file.');
    if (file.size > 30 * 1024 * 1024) return soundError('This file is too large (max 30 MB).');
    el.soundFileLabel.textContent = 'Reading ' + file.name + '…';
    try {
      state.upload.buffer = await state.soundboard.decodeFile(file);
    } catch (e) {
      el.soundFileLabel.textContent = 'Choose an .mp3 or drop it here';
      return soundError('Could not read this mp3.');
    }
    el.soundFileLabel.textContent = file.name;
    if (!el.inputSoundName.value) el.inputSoundName.value = file.name.replace(/\.mp3$/i, '').slice(0, 24);
    el.sliderSoundStart.value = 0;
    el.soundTrimBox.classList.remove('hidden');
    el.btnSubmitSound.disabled = false;
    updateTrimUI();
  }

  function trimRange() {
    const b = state.upload.buffer;
    const maxStart = Math.max(0, b.duration - state.upload.length);
    const start = Math.min(parseInt(el.sliderSoundStart.value, 10) / 10, maxStart);
    return [start, Math.min(state.upload.length, b.duration - start)];
  }

  function updateTrimUI() {
    const b = state.upload && state.upload.buffer;
    if (!b) return;
    const maxStart = Math.max(0, b.duration - state.upload.length);
    el.sliderSoundStart.max = Math.floor(maxStart * 10); // tenths of a second
    el.sliderSoundStart.disabled = maxStart <= 0;
    const [start, len] = trimRange();
    el.soundStartLabel.textContent = `${fmtSec(start)} → ${fmtSec(start + len)}  ·  clip ${len.toFixed(1)} s of ${fmtSec(b.duration)}`;
  }

  function previewUpload() {
    if (!state.upload || !state.upload.buffer) return;
    stopPreview();
    const [start, len] = trimRange();
    state.upload.preview = state.soundboard.preview(state.upload.buffer, start, len);
  }

  function stopPreview() {
    if (state.upload && state.upload.preview) {
      try { state.upload.preview.stop(); } catch (e) {}
      state.upload.preview = null;
    }
  }

  async function submitSound() {
    if (!state.upload || !state.upload.buffer || !state.socket) return;
    const name = el.inputSoundName.value.trim().slice(0, 24) || 'Sound';
    const reset = () => { el.btnSubmitSound.disabled = false; el.btnSubmitSound.textContent = 'Upload'; };
    el.btnSubmitSound.disabled = true;
    el.btnSubmitSound.textContent = 'Uploading…';
    el.addSoundError.classList.add('hidden');
    try {
      const [start, len] = trimRange();
      const data = await state.soundboard.encode(state.upload.buffer, start, len);
      state.socket.timeout(20000).emit('sound_upload', { name, duration: Math.round(len * 10) / 10, data }, (err, res) => {
        reset();
        if (err || !res || !res.success) return soundError((res && res.error) || 'Upload failed. Try again.');
        stopPreview();
        el.modalAddSound.classList.add('hidden');
        toast('Sound added to the soundboard', 'ok');
      });
    } catch (e) {
      reset();
      soundError('Could not process this sound: ' + e.message);
    }
  }

  function fetchSound(id) {
    return new Promise((resolve, reject) => {
      if (!state.socket) return reject(new Error('Offline'));
      state.socket.timeout(15000).emit('sound_get', { id }, (err, res) => {
        if (err || !res || !res.success) return reject(new Error((res && res.error) || 'Sound unavailable'));
        resolve(res.data);
      });
    });
  }

  function setSounds(list) {
    state.sounds = list || [];
    state.soundboard.retain(state.sounds.map(s => s.id));
    renderSounds();
    state.sounds.forEach(s => state.soundboard.prefetch(s.id, fetchSound).catch(() => {}));
  }

  function renderSounds() {
    el.soundGrid.innerHTML = '';
    el.soundCount.textContent = state.sounds.length ? String(state.sounds.length) : '';
    if (!state.sounds.length) {
      el.soundGrid.innerHTML = '<div class="sound-empty">No sounds yet. Add an .mp3 — everyone in this lobby will be able to play it.</div>';
      return;
    }
    const owner = state.currentLobby && state.currentLobby.creatorTag === state.tag;
    state.sounds.forEach(s => {
      const b = document.createElement('div');
      b.className = 'sound-btn';
      b.id = 'sound-' + s.id;
      b.innerHTML = `
        <span class="sound-name"></span>
        <span class="sound-meta">${Number(s.duration).toFixed(1)} s · <span class="sound-by"></span></span>
        ${s.uploaderTag === state.tag || owner ? '<button type="button" class="sound-del" title="Remove">&times;</button>' : ''}
      `;
      b.querySelector('.sound-name').textContent = s.name;
      b.querySelector('.sound-by').textContent = s.uploaderName;
      b.addEventListener('click', (e) => {
        if (e.target.closest('.sound-del')) return;
        state.socket.emit('sound_play', { id: s.id }, (res) => {
          if (res && !res.success && !res.rate) toast(res.error);
        });
      });
      const del = b.querySelector('.sound-del');
      if (del) del.addEventListener('click', () => {
        state.socket.emit('sound_delete', { id: s.id }, (res) => {
          if (!res || !res.success) toast((res && res.error) || 'Could not remove the sound.');
        });
      });
      el.soundGrid.appendChild(b);
    });
  }

  function flashSound(id, duration) {
    const b = document.getElementById('sound-' + id);
    if (!b) return;
    b.style.setProperty('--d', duration + 's');
    b.classList.remove('playing');
    void b.offsetWidth;
    b.classList.add('playing');
    clearTimeout(b._pvTimer);
    b._pvTimer = setTimeout(() => b.classList.remove('playing'), duration * 1000);
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtSec(s) {
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
  }

  function safeColor(c) {
    return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#8e8e93';
  }

  function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t || '';
    return d.innerHTML;
  }

})();
