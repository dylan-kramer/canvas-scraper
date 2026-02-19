// Background service worker - handles downloads even when popup is closed

// Import JSZip at top level (required for MV3 service workers)
importScripts('jszip.min.js');

const CANVAS_BASE = 'https://canvas.unl.edu';
const API_BASE = `${CANVAS_BASE}/api/v1`;

let downloadState = {
  running: false,
  phase: 'idle', // idle, scanning, downloading, zipping, done, error, cancelled
  progress: 0,
  progressText: '',
  totalFiles: 0,
  downloadedFiles: 0,
  failedFiles: 0,
  error: null
};

let abortController = null;

// Broadcast state to any open popups
function broadcastState() {
  chrome.runtime.sendMessage({ action: 'stateUpdate', state: downloadState }).catch(() => {
    // Popup might not be open, ignore error
  });
}

function updateState(updates) {
  downloadState = { ...downloadState, ...updates };
  broadcastState();
  // Also persist to storage for recovery
  chrome.storage.local.set({ downloadState });
}

// API helpers
async function apiGet(endpoint, signal) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    credentials: 'include',
    signal
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}

async function apiGetAll(endpoint, signal) {
  let results = [];
  let url = `${API_BASE}${endpoint}`;
  
  while (url) {
    const response = await fetch(url, { credentials: 'include', signal });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    
    const data = await response.json();
    results = results.concat(data);
    
    const link = response.headers.get('Link');
    url = null;
    if (link) {
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      if (next) url = next[1];
    }
  }
  return results;
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
}

function extractFileUrls(html) {
  if (!html) return [];
  const files = [];
  const filePattern = /\/courses\/\d+\/files\/(\d+)|\/files\/(\d+)/g;
  let match;
  const seen = new Set();
  
  while ((match = filePattern.exec(html)) !== null) {
    const fileId = match[1] || match[2];
    if (!seen.has(fileId)) {
      seen.add(fileId);
      files.push(fileId);
    }
  }
  return files;
}

async function getPageContent(courseId, pageUrl, signal) {
  try {
    return await apiGet(`/courses/${courseId}/pages/${pageUrl}`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
}

async function processModule(courseId, courseName, mod, signal) {
  const thisModuleName = sanitizeFilename(mod.name);
  const moduleDownloads = [];
  
  if (!mod.items || mod.items.length === 0) {
    return moduleDownloads;
  }
  
  for (const item of mod.items) {
    if (item.type === 'File' && item.url) {
      try {
        const fileData = await apiGet(item.url.replace(API_BASE, ''), signal);
        if (fileData && fileData.url) {
          moduleDownloads.push({
            url: fileData.url,
            filename: `${courseName}/Modules/${thisModuleName}/${fileData.display_name}`,
            size: fileData.size || 0
          });
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    
    if (item.type === 'Page' && item.page_url) {
      try {
        const pageData = await getPageContent(courseId, item.page_url, signal);
        if (pageData && pageData.body) {
          const fileIds = extractFileUrls(pageData.body);
          for (const fileId of fileIds) {
            try {
              const fileData = await apiGet(`/files/${fileId}`, signal);
              if (fileData && fileData.url) {
                moduleDownloads.push({
                  url: fileData.url,
                  filename: `${courseName}/Modules/${thisModuleName}/${fileData.display_name}`,
                  size: fileData.size || 0
                });
              }
            } catch (e) {
              if (e.name === 'AbortError') throw e;
            }
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }
    
    if (item.type === 'ExternalUrl' && item.external_url) {
      const fileMatch = item.external_url.match(/\/files\/(\d+)/);
      if (fileMatch) {
        try {
          const fileData = await apiGet(`/files/${fileMatch[1]}`, signal);
          if (fileData && fileData.url) {
            moduleDownloads.push({
              url: fileData.url,
              filename: `${courseName}/Modules/${thisModuleName}/${fileData.display_name}`,
              size: fileData.size || 0
            });
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
        }
      }
    }
  }
  
  return moduleDownloads;
}

async function collectDownloads(course, user, signal, onProgress) {
  const courseName = sanitizeFilename(course.name);
  const downloads = [];
  
  // Files tab
  onProgress(0, `${courseName}: Scanning files...`);
  try {
    const folders = await apiGetAll(`/courses/${course.id}/folders?per_page=100`, signal);
    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      try {
        const files = await apiGetAll(`/folders/${folder.id}/files?per_page=100`, signal);
        for (const file of files) {
          downloads.push({
            url: file.url,
            filename: `${courseName}/Files/${file.display_name}`,
            size: file.size || 0
          });
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
      onProgress((i + 1) / folders.length * 0.2, `${courseName}: Scanned ${i + 1}/${folders.length} folders`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    onProgress(0.2, `${courseName}: Files tab not accessible`);
  }
  
  // Modules
  onProgress(0.2, `${courseName}: Scanning modules...`);
  try {
    const modules = await apiGetAll(`/courses/${course.id}/modules?include[]=items&per_page=50`, signal);
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i];
      const moduleFiles = await processModule(course.id, courseName, mod, signal);
      downloads.push(...moduleFiles);
      onProgress(0.2 + (i + 1) / modules.length * 0.4, `${courseName}: Scanned module ${mod.name}`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  
  // Assignments
  onProgress(0.6, `${courseName}: Scanning assignments...`);
  try {
    const assignments = await apiGetAll(`/courses/${course.id}/assignments?per_page=50`, signal);
    for (let i = 0; i < assignments.length; i++) {
      const assignment = assignments[i];
      const assignmentName = sanitizeFilename(assignment.name);
      
      if (assignment.attachments) {
        for (const att of assignment.attachments) {
          downloads.push({
            url: att.url,
            filename: `${courseName}/Assignments/${assignmentName}/Instructions/${att.display_name}`,
            size: att.size || 0
          });
        }
      }
      
      try {
        const submission = await apiGet(
          `/courses/${course.id}/assignments/${assignment.id}/submissions/${user.id}?include[]=submission_history`,
          signal
        );
        if (submission) {
          const history = submission.submission_history || [submission];
          for (let h = 0; h < history.length; h++) {
            const attempt = history[h];
            if (attempt.attachments) {
              for (const att of attempt.attachments) {
                downloads.push({
                  url: att.url,
                  filename: `${courseName}/Assignments/${assignmentName}/Submissions/attempt_${h + 1}/${att.display_name}`,
                  size: att.size || 0
                });
              }
            }
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
      
      onProgress(0.6 + (i + 1) / assignments.length * 0.4, `${courseName}: Scanned ${i + 1}/${assignments.length} assignments`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  
  return downloads;
}

async function fetchFileAsBlob(url, signal) {
  const response = await fetch(url, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`Failed: ${response.status}`);
  return await response.blob();
}

async function startDownload(courses, user) {
  if (downloadState.running) return;
  
  abortController = new AbortController();
  const signal = abortController.signal;
  
  updateState({
    running: true,
    phase: 'scanning',
    progress: 0,
    progressText: 'Starting...',
    totalFiles: 0,
    downloadedFiles: 0,
    failedFiles: 0,
    error: null
  });
  
  try {
    // Phase 1: Collect downloads
    let allDownloads = [];
    for (let i = 0; i < courses.length; i++) {
      const course = courses[i];
      const courseDownloads = await collectDownloads(course, user, signal, (p, text) => {
        const overallProgress = (i + p) / courses.length * 0.3;
        updateState({ progress: overallProgress, progressText: text });
      });
      allDownloads = allDownloads.concat(courseDownloads);
    }
    
    // Deduplicate by filename
    const seen = new Set();
    allDownloads = allDownloads.filter(d => {
      if (seen.has(d.filename)) return false;
      seen.add(d.filename);
      return true;
    });
    
    if (allDownloads.length === 0) {
      updateState({ running: false, phase: 'error', error: 'No files found' });
      return;
    }
    
    updateState({
      phase: 'downloading',
      totalFiles: allDownloads.length,
      progressText: `Downloading 0/${allDownloads.length}...`
    });
    
    // Phase 2: Download files
    const zip = new JSZip();
    let downloaded = 0;
    let failed = 0;
    
    for (const dl of allDownloads) {
      signal.throwIfAborted();
      
      const shortName = dl.filename.split('/').pop();
      updateState({
        progress: 0.3 + (downloaded / allDownloads.length) * 0.5,
        progressText: `Downloading ${downloaded + 1}/${allDownloads.length}: ${shortName}`,
        downloadedFiles: downloaded,
        failedFiles: failed
      });
      
      try {
        const blob = await fetchFileAsBlob(dl.url, signal);
        zip.file(dl.filename, blob);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failed++;
      }
      
      downloaded++;
      await new Promise(r => setTimeout(r, 50));
    }
    
    signal.throwIfAborted();
    
    // Phase 3: Generate ZIP
    updateState({ phase: 'zipping', progress: 0.8, progressText: 'Generating ZIP...' });
    
    // Generate ZIP as base64 (service workers don't have URL.createObjectURL)
    const zipBase64 = await zip.generateAsync({
      type: 'base64',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    }, (metadata) => {
      updateState({
        progress: 0.8 + (metadata.percent / 100) * 0.2,
        progressText: `Compressing: ${Math.round(metadata.percent)}%`
      });
    });
    
    // Download the ZIP using data URL
    const zipUrl = `data:application/zip;base64,${zipBase64}`;
    const timestamp = new Date().toISOString().slice(0, 10);
    const zipName = courses.length === 1
      ? `${sanitizeFilename(courses[0].name)}_${timestamp}.zip`
      : `Canvas_Courses_${timestamp}.zip`;
    
    chrome.downloads.download({ url: zipUrl, filename: zipName, saveAs: false });
    
    updateState({
      running: false,
      phase: 'done',
      progress: 1,
      progressText: `Done! ${downloaded - failed} files downloaded`,
      downloadedFiles: downloaded - failed,
      failedFiles: failed
    });
    
  } catch (e) {
    if (e.name === 'AbortError') {
      updateState({ running: false, phase: 'cancelled', progressText: 'Cancelled' });
    } else {
      console.error(e);
      updateState({ running: false, phase: 'error', error: e.message });
    }
  } finally {
    abortController = null;
  }
}

function stopDownload() {
  if (abortController) {
    abortController.abort();
  }
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getState') {
    sendResponse(downloadState);
    return true;
  }
  
  if (message.action === 'start') {
    startDownload(message.courses, message.user);
    sendResponse({ ok: true });
    return true;
  }
  
  if (message.action === 'stop') {
    stopDownload();
    sendResponse({ ok: true });
    return true;
  }
  
  if (message.action === 'download') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: false
    }, (downloadId) => {
      sendResponse({ success: true, downloadId });
    });
    return true;
  }
});

// Restore state on startup
chrome.storage.local.get('downloadState', (result) => {
  if (result.downloadState && !result.downloadState.running) {
    downloadState = result.downloadState;
  }
});
