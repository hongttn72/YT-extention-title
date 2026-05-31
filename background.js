// YT Hologram Extractor - Background Service Worker

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchVideoData') {
    handleFetchVideoData(message.videoId, message.extraData)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (message.action === 'translateText') {
    handleTranslateText(message.text)
      .then(translated => sendResponse({ success: true, translated }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }
});

async function handleFetchVideoData(videoId, extraData = {}) {
  if (!videoId) throw new Error('Invalid video ID');

  // 1. Fetch player data from InnerTube API
  const playerResp = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20230101.00.00',
          hl: 'en',
          gl: 'US'
        }
      }
    })
  });

  if (!playerResp.ok) throw new Error(`InnerTube API error: ${playerResp.status}`);
  const playerData = await playerResp.json();

  const vd = playerData.videoDetails || {};
  const title = vd.title || '';
  const channelName = vd.author || '';
  const viewCount = vd.viewCount ? Number(vd.viewCount).toLocaleString('en-US') : '';
  const lengthSeconds = parseInt(vd.lengthSeconds || '0', 10);
  const duration = formatDuration(lengthSeconds);

  // Extract best thumbnail
  const thumbs = vd.thumbnail?.thumbnails || [];
  const thumbnailUrl = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';

  // Extract captions
  const captionTracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  let transcript = '';

  if (captionTracks.length > 0) {
    // Prefer English track if available
    let track = captionTracks.find(t => t.languageCode === 'en') || captionTracks[0];
    try {
      transcript = await fetchTranscript(track.baseUrl);
    } catch (e) {
      transcript = '';
    }
  }

  // Translate title
  let titleVi = '';
  try {
    titleVi = await handleTranslateText(title);
  } catch (e) {
    titleVi = '';
  }

  return {
    stt: extraData.stt || '',
    kenh: extraData.kenh || '',
    link: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    titleVi,
    channelName,
    viewCount,
    duration,
    thumbnailUrl,
    transcript
  };
}

async function fetchTranscript(baseUrl) {
  const url = baseUrl + '&fmt=json3';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Transcript fetch failed');
  const data = await resp.json();

  const events = data.events || [];
  const parts = [];
  for (const event of events) {
    if (!event.segs) continue;
    for (const seg of event.segs) {
      if (seg.utf8 && seg.utf8.trim() && seg.utf8 !== '\n') {
        parts.push(seg.utf8.trim());
      }
    }
  }
  return parts.join(' ');
}

async function handleTranslateText(text) {
  if (!text || !text.trim()) return '';
  const encoded = encodeURIComponent(text.substring(0, 500)); // API limit
  const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|vi`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Translation API error');
  const data = await resp.json();
  return data.responseData?.translatedText || text;
}

function extractVideoId(url) {
  if (!url) return null;
  url = url.trim();

  // youtu.be/ID
  let m = url.match(/youtu\.be\/([^?&#/]+)/);
  if (m) return m[1];

  // youtube.com/watch?v=ID
  m = url.match(/[?&]v=([^?&#/]+)/);
  if (m) return m[1];

  // youtube.com/shorts/ID
  m = url.match(/\/shorts\/([^?&#/]+)/);
  if (m) return m[1];

  // youtube.com/live/ID
  m = url.match(/\/live\/([^?&#/]+)/);
  if (m) return m[1];

  // youtube.com/embed/ID
  m = url.match(/\/embed\/([^?&#/]+)/);
  if (m) return m[1];

  return null;
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${m}:${ss}`;
}
