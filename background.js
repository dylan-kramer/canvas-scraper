// Background service worker - handles downloads even when popup is closed

// Import JSZip at top level (required for MV3 service workers)
importScripts('jszip.min.js');

let CANVAS_BASE = 'https://canvas.unl.edu';
let API_BASE = `${CANVAS_BASE}/api/v1`;
let currentSignal = null;

function setCanvasBase(baseUrl) {
  if (baseUrl) {
    CANVAS_BASE = baseUrl;
    API_BASE = `${CANVAS_BASE}/api/v1`;
  }
}
const CONCURRENT_DOWNLOADS = 4;

let downloadState = {
  running: false,
  phase: 'idle', // idle, scanning, confirming, downloading, zipping, done, error, cancelled
  progress: 0,
  progressText: '',
  totalFiles: 0,
  downloadedFiles: 0,
  failedFiles: 0,
  estimatedSize: 0,
  error: null,
  pendingDownloads: null // Holds downloads awaiting confirmation
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

// NEW: Collect discussion attachments
async function collectDiscussions(courseId, courseName, signal) {
  const downloads = [];
  
  try {
    const topics = await apiGetAll(`/courses/${courseId}/discussion_topics?per_page=50`, signal);
    
    for (const topic of topics) {
      const topicName = sanitizeFilename(topic.title || 'Untitled');
      
      // Attachments on the topic itself
      if (topic.attachments) {
        for (const att of topic.attachments) {
          downloads.push({
            url: att.url,
            filename: `${courseName}/Discussions/${topicName}/${att.display_name}`,
            size: att.size || 0
          });
        }
      }
      
      // Get entries for this topic
      try {
        const entries = await apiGetAll(`/courses/${courseId}/discussion_topics/${topic.id}/entries?per_page=50`, signal);
        for (const entry of entries) {
          if (entry.attachment) {
            downloads.push({
              url: entry.attachment.url,
              filename: `${courseName}/Discussions/${topicName}/${entry.attachment.display_name}`,
              size: entry.attachment.size || 0
            });
          }
          // Check replies too
          if (entry.recent_replies) {
            for (const reply of entry.recent_replies) {
              if (reply.attachment) {
                downloads.push({
                  url: reply.attachment.url,
                  filename: `${courseName}/Discussions/${topicName}/${reply.attachment.display_name}`,
                  size: reply.attachment.size || 0
                });
              }
            }
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // 403 on entries is common, skip
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Discussions not accessible, skip
  }
  
  return downloads;
}

// NEW: Collect syllabus
async function collectSyllabus(courseId, courseName, signal) {
  const downloads = [];
  
  try {
    const syllabus = await apiGet(`/courses/${courseId}`, signal);
    if (syllabus && syllabus.syllabus_body) {
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Syllabus</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
    h1 { color: #333; }
    .meta { color: #666; font-size: 14px; margin-bottom: 20px; }
    .content { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${syllabus.name || 'Course Syllabus'}</h1>
  <div class="meta">Term: ${syllabus.term ? syllabus.term.name : 'N/A'}</div>
  <div class="content">${syllabus.syllabus_body || ''}</div>
</body>
</html>`;
      
      downloads.push({
        content: htmlContent,
        filename: `${courseName}/Syllabus.html`,
        size: htmlContent.length,
        isText: true
      });
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  
  return downloads;
}

// NEW: Collect announcements (as HTML files + attachments)
async function collectAnnouncements(courseId, courseName, signal) {
  const downloads = [];
  
  try {
    const announcements = await apiGetAll(`/courses/${courseId}/discussion_topics?only_announcements=true&per_page=50`, signal);
    
    for (const ann of announcements) {
      const annTitle = sanitizeFilename(ann.title || 'Untitled');
      
      // Save announcement content as HTML
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${ann.title || 'Announcement'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
    h1 { color: #333; }
    .meta { color: #666; font-size: 14px; margin-bottom: 20px; }
    .content { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${ann.title || 'Announcement'}</h1>
  <div class="meta">Posted: ${ann.posted_at || ann.created_at || 'Unknown'}</div>
  <div class="content">${ann.message || ''}</div>
</body>
</html>`;
      
      downloads.push({
        content: htmlContent,
        filename: `${courseName}/Announcements/${annTitle}.html`,
        size: htmlContent.length,
        isText: true
      });
      
      // Attachments on the announcement
      if (ann.attachments) {
        for (const att of ann.attachments) {
          downloads.push({
            url: att.url,
            filename: `${courseName}/Announcements/${annTitle}/${att.display_name}`,
            size: att.size || 0
          });
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Announcements not accessible, skip
  }
  
  return downloads;
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
      onProgress((i + 1) / folders.length * 0.15, `${courseName}: Scanned ${i + 1}/${folders.length} folders`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    onProgress(0.15, `${courseName}: Files tab not accessible`);
  }
  
  // Modules
  onProgress(0.15, `${courseName}: Scanning modules...`);
  try {
    const modules = await apiGetAll(`/courses/${course.id}/modules?include[]=items&per_page=50`, signal);
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i];
      const moduleFiles = await processModule(course.id, courseName, mod, signal);
      downloads.push(...moduleFiles);
      onProgress(0.15 + (i + 1) / modules.length * 0.25, `${courseName}: Scanned module ${mod.name}`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  
  // Assignments
  onProgress(0.4, `${courseName}: Scanning assignments...`);
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
      
      onProgress(0.4 + (i + 1) / assignments.length * 0.25, `${courseName}: Scanned ${i + 1}/${assignments.length} assignments`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  
  // Syllabus
  onProgress(0.65, `${courseName}: Scanning syllabus...`);
  const syllabusDownloads = await collectSyllabus(course.id, courseName, signal);
  downloads.push(...syllabusDownloads);

  // NEW: Discussions
  onProgress(0.7, `${courseName}: Scanning discussions...`);
  const discussionDownloads = await collectDiscussions(course.id, courseName, signal);
  downloads.push(...discussionDownloads);
  
  // NEW: Announcements
  onProgress(0.8, `${courseName}: Scanning announcements...`);
  const announcementDownloads = await collectAnnouncements(course.id, courseName, signal);
  downloads.push(...announcementDownloads);
  
  onProgress(1, `${courseName}: Scan complete`);
  
  return downloads;
}

async function fetchFileAsBlob(url, signal) {
  const response = await fetch(url, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`Failed: ${response.status}`);
  return await response.blob();
}

// NEW: Concurrent download pool with retry
async function downloadWithConcurrency(downloads, zip, signal, onProgress) {
  let completed = 0;
  let failed = 0;
  const total = downloads.length;
  const MAX_RETRIES = 3;
  
  // Create a queue of work
  const queue = [...downloads];
  const workers = [];
  
  async function worker() {
    while (queue.length > 0) {
      signal.throwIfAborted();
      
      const dl = queue.shift();
      if (!dl) break;
      
      const shortName = dl.filename.split('/').pop();
      let success = false;
      let retries = 0;
      
      while (!success && retries < MAX_RETRIES) {
        try {
          if (dl.isText) {
            zip.file(dl.filename, dl.content);
            success = true;
          } else {
            const blob = await fetchFileAsBlob(dl.url, signal);
            zip.file(dl.filename, blob);
            success = true;
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          retries++;
          if (retries >= MAX_RETRIES) {
            failed++;
          }
        }
      }
      
      completed++;
      onProgress(completed, failed, total, shortName);
    }
  }
  
  // Start workers
  for (let i = 0; i < CONCURRENT_DOWNLOADS; i++) {
    workers.push(worker());
  }
  
  // Wait for all workers to finish
  await Promise.all(workers);
  
  return { completed, failed };
}

async function scanOnly(courses, user) {
  if (downloadState.running) return;
  
  abortController = new AbortController();
  const signal = abortController.signal;
  
  updateState({
    running: true,
    phase: 'scanning',
    progress: 0,
    progressText: 'Starting scan...',
    totalFiles: 0,
    downloadedFiles: 0,
    failedFiles: 0,
    estimatedSize: 0,
    error: null,
    pendingDownloads: null
  });
  
  try {
    // Phase 1: Collect downloads
    let allDownloads = [];
    for (let i = 0; i < courses.length; i++) {
      const course = courses[i];
      const courseDownloads = await collectDownloads(course, user, signal, (p, text) => {
        const overallProgress = (i + p) / courses.length;
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
    
    // Calculate total size
    const totalSize = allDownloads.reduce((sum, d) => sum + (d.size || 0), 0);
    
    // Store downloads and wait for confirmation
    updateState({
      running: false,
      phase: 'confirming',
      totalFiles: allDownloads.length,
      estimatedSize: totalSize,
      progressText: `Found ${allDownloads.length} files`,
      pendingDownloads: allDownloads
    });
    
    // Store for later use
    chrome.storage.local.set({ 
      pendingDownloads: allDownloads,
      pendingCourses: courses 
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

async function confirmDownload(courses) {
  // Retrieve pending downloads from storage
  const { pendingDownloads } = await chrome.storage.local.get('pendingDownloads');
  
  if (!pendingDownloads || pendingDownloads.length === 0) {
    updateState({ running: false, phase: 'error', error: 'No pending downloads' });
    return;
  }
  
  abortController = new AbortController();
  const signal = abortController.signal;
  
  updateState({
    running: true,
    phase: 'downloading',
    progress: 0.3,
    totalFiles: pendingDownloads.length,
    downloadedFiles: 0,
    failedFiles: 0,
    progressText: `Downloading 0/${pendingDownloads.length}...`,
    pendingDownloads: null
  });
  
  try {
    // Phase 2: Download files concurrently
    const zip = new JSZip();
    
    const { completed, failed } = await downloadWithConcurrency(
      pendingDownloads,
      zip,
      signal,
      (done, failCount, total, currentFile) => {
        updateState({
          progress: 0.3 + (done / total) * 0.5,
          progressText: `Downloading ${done}/${total}: ${currentFile}`,
          downloadedFiles: done - failCount,
          failedFiles: failCount
        });
      }
    );
    
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
    
    // Clear pending downloads
    chrome.storage.local.remove(['pendingDownloads', 'pendingCourses']);
    
    updateState({
      running: false,
      phase: 'done',
      progress: 1,
      progressText: `Done! ${completed - failed} files downloaded`,
      downloadedFiles: completed - failed,
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
  // Clear pending downloads on cancel
  chrome.storage.local.remove(['pendingDownloads', 'pendingCourses']);
  updateState({ 
    running: false, 
    phase: 'cancelled', 
    pendingDownloads: null 
  });
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getState') {
    sendResponse(downloadState);
    return true;
  }
  
  if (message.action === 'scan') {
    setCanvasBase(message.canvasBase);
    scanOnly(message.courses, message.user);
    sendResponse({ ok: true });
    return true;
  }
  
  if (message.action === 'confirmDownload') {
    setCanvasBase(message.canvasBase);
    confirmDownload(message.courses);
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
