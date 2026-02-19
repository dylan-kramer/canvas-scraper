// Canvas API helper
const CANVAS_BASE = 'https://canvas.unl.edu';
const API_BASE = `${CANVAS_BASE}/api/v1`;

// Abort controller for cancellation
let abortController = null;
let isRunning = false;

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

// Paginated fetch - Canvas API uses Link headers
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

function setStatus(text, type = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = 'status ' + type;
}

function setProgress(percent, text) {
  document.getElementById('progress-fill').style.width = percent + '%';
  document.getElementById('progress-text').textContent = text;
}

function setRunning(running) {
  isRunning = running;
  document.getElementById('download-btn').style.display = running ? 'none' : 'block';
  document.getElementById('stop-btn').style.display = running ? 'block' : 'none';
  document.getElementById('progress').style.display = running ? 'block' : 'none';
  
  // Disable/enable course checkboxes
  document.querySelectorAll('#course-list input').forEach(cb => {
    cb.disabled = running;
  });
  document.getElementById('toggle-all').disabled = running;
}

async function getCourses(signal) {
  const courses = await apiGetAll('/courses?enrollment_state=active&include[]=term&per_page=50', signal);
  return courses.filter(c => c.name);
}

async function getFolderFiles(folderId, signal) {
  try {
    return await apiGetAll(`/folders/${folderId}/files?per_page=100`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn(`Could not get files for folder ${folderId}:`, e);
    return [];
  }
}

async function getCourseFolders(courseId, signal) {
  // Let errors propagate - caller handles Files tab being disabled
  return await apiGetAll(`/courses/${courseId}/folders?per_page=100`, signal);
}

async function getCourseModules(courseId, signal) {
  try {
    return await apiGetAll(`/courses/${courseId}/modules?include[]=items&per_page=50`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn(`Could not get modules for course ${courseId}:`, e);
    return [];
  }
}

async function getCourseAssignments(courseId, signal) {
  try {
    return await apiGetAll(`/courses/${courseId}/assignments?per_page=50`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn(`Could not get assignments for course ${courseId}:`, e);
    return [];
  }
}

async function getCourseFrontPage(courseId, signal) {
  try {
    return await apiGet(`/courses/${courseId}/front_page`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
}

async function getCourseAnnouncements(courseId, signal) {
  try {
    return await apiGetAll(`/courses/${courseId}/discussion_topics?only_announcements=true&per_page=50`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn(`Could not get announcements for course ${courseId}:`, e);
    return [];
  }
}

async function getDiscussionTopic(courseId, topicId, signal) {
  try {
    return await apiGet(`/courses/${courseId}/discussion_topics/${topicId}`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
}

// Extract file URLs from HTML content (for pages/announcements)
function extractFileUrls(html, courseId) {
  if (!html) return [];
  const files = [];
  
  // Match Canvas file URLs: /courses/123/files/456 or /files/456
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

async function getSubmission(courseId, assignmentId, userId, signal) {
  try {
    return await apiGet(`/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
}

async function getCurrentUser(signal) {
  return await apiGet('/users/self', signal);
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
}

function buildFolderPath(folders, folderId) {
  const folderMap = {};
  folders.forEach(f => folderMap[f.id] = f);
  
  const parts = [];
  let current = folderMap[folderId];
  while (current) {
    if (current.name !== 'course files') {
      parts.unshift(sanitizeFilename(current.name));
    }
    current = current.parent_folder_id ? folderMap[current.parent_folder_id] : null;
  }
  return parts.join('/');
}

// Progress tracking
class ProgressTracker {
  constructor() {
    this.phases = [];
    this.currentPhase = 0;
    this.phaseProgress = 0;
  }
  
  setPhases(phases) {
    this.phases = phases;
    const totalWeight = phases.reduce((sum, p) => sum + p.weight, 0);
    let cumulative = 0;
    this.phases.forEach(p => {
      p.start = cumulative / totalWeight;
      p.end = (cumulative + p.weight) / totalWeight;
      cumulative += p.weight;
    });
    this.currentPhase = 0;
    this.phaseProgress = 0;
  }
  
  setPhase(index) {
    this.currentPhase = index;
    this.phaseProgress = 0;
  }
  
  update(progress, text) {
    this.phaseProgress = progress;
    const phase = this.phases[this.currentPhase];
    const overall = phase.start + (phase.end - phase.start) * progress;
    setProgress(Math.round(overall * 100), text);
  }
}

async function collectDownloads(course, user, signal, onProgress) {
  const courseName = sanitizeFilename(course.name);
  const downloads = [];
  
  // === 1. FILES TAB (may be disabled by professor) ===
  onProgress(0, `${courseName}: Scanning files...`);
  
  try {
    const folders = await getCourseFolders(course.id, signal);
    
    if (folders.length > 0) {
      // Build folder path map
      const folderMap = {};
      folders.forEach(f => folderMap[f.id] = f);
      
      function getFolderPath(folderId) {
        const parts = [];
        let current = folderMap[folderId];
        while (current) {
          if (current.name && current.name.toLowerCase() !== 'course files') {
            parts.unshift(sanitizeFilename(current.name));
          }
          current = current.parent_folder_id ? folderMap[current.parent_folder_id] : null;
        }
        return parts.join('/');
      }
      
      for (let i = 0; i < folders.length; i++) {
        const folder = folders[i];
        const folderFiles = await getFolderFiles(folder.id, signal);
        
        for (const file of folderFiles) {
          const folderPath = getFolderPath(file.folder_id);
          const path = folderPath 
            ? `${courseName}/Files/${folderPath}/${file.display_name}`
            : `${courseName}/Files/${file.display_name}`;
          downloads.push({ url: file.url, filename: path, size: file.size || 0 });
        }
        
        onProgress((i + 1) / folders.length * 0.25, 
          `${courseName}: Scanned ${i + 1}/${folders.length} folders (${downloads.length} files)`);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn(`Files tab disabled or inaccessible for ${courseName}:`, e);
    onProgress(0.25, `${courseName}: Files tab not accessible, continuing...`);
  }
  
  // === 2. HOME TAB (front page + announcements) ===
  onProgress(0.2, `${courseName}: Scanning home page...`);
  
  try {
    // Front page
    const frontPage = await getCourseFrontPage(course.id, signal);
    if (frontPage && frontPage.body) {
      const fileIds = extractFileUrls(frontPage.body, course.id);
      for (const fileId of fileIds) {
        try {
          const fileData = await apiGet(`/files/${fileId}`, signal);
          if (fileData.url) {
            downloads.push({
              url: fileData.url,
              filename: `${courseName}/Home/${fileData.display_name}`,
              size: fileData.size || 0
            });
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          console.warn('Could not fetch home page file:', e);
        }
      }
    }
    
    // Announcements
    onProgress(0.25, `${courseName}: Scanning announcements...`);
    const announcements = await getCourseAnnouncements(course.id, signal);
    
    for (const ann of announcements) {
      const annName = sanitizeFilename(ann.title || 'Untitled');
      
      // Attachments directly on the announcement
      if (ann.attachments && ann.attachments.length > 0) {
        for (const att of ann.attachments) {
          downloads.push({
            url: att.url,
            filename: `${courseName}/Announcements/${annName}/${att.display_name}`,
            size: att.size || 0
          });
        }
      }
      
      // Files linked in announcement body
      if (ann.message) {
        const fileIds = extractFileUrls(ann.message, course.id);
        for (const fileId of fileIds) {
          try {
            const fileData = await apiGet(`/files/${fileId}`, signal);
            if (fileData.url) {
              downloads.push({
                url: fileData.url,
                filename: `${courseName}/Announcements/${annName}/${fileData.display_name}`,
                size: fileData.size || 0
              });
            }
          } catch (e) {
            if (e.name === 'AbortError') throw e;
          }
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn(`Could not scan home/announcements for ${courseName}:`, e);
  }
  
  // === 3. MODULES (works even when Files is disabled) ===
  onProgress(0.35, `${courseName}: Scanning modules...`);
  const modules = await getCourseModules(course.id, signal);
  
  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    const moduleName = sanitizeFilename(mod.name);
    if (!mod.items) continue;
    
    for (const item of mod.items) {
      if (item.type === 'File' && item.url) {
        try {
          const fileData = await apiGet(item.url.replace(API_BASE, ''), signal);
          if (fileData.url) {
            downloads.push({
              url: fileData.url,
              filename: `${courseName}/Modules/${moduleName}/${fileData.display_name}`,
              size: fileData.size || 0
            });
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          console.warn('Could not fetch module file:', e);
        }
      }
    }
    
    onProgress(0.35 + (i + 1) / modules.length * 0.2,
      `${courseName}: Scanned ${i + 1}/${modules.length} modules`);
  }
  
  // === 4. ASSIGNMENTS (both professor attachments AND your submissions) ===
  onProgress(0.55, `${courseName}: Scanning assignments...`);
  const assignments = await getCourseAssignments(course.id, signal);
  
  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i];
    const assignmentName = sanitizeFilename(assignment.name);
    
    // 4a. Professor's attachments TO the assignment
    if (assignment.attachments && assignment.attachments.length > 0) {
      for (const att of assignment.attachments) {
        downloads.push({
          url: att.url,
          filename: `${courseName}/Assignments/${assignmentName}/Instructions/${att.display_name}`,
          size: att.size || 0
        });
      }
    }
    
    // 4b. Your submission attachments
    const submission = await getSubmission(course.id, assignment.id, user.id, signal);
    if (submission && submission.attachments) {
      for (const att of submission.attachments) {
        downloads.push({
          url: att.url,
          filename: `${courseName}/Assignments/${assignmentName}/Submissions/${att.display_name}`,
          size: att.size || 0
        });
      }
    }
    
    onProgress(0.55 + (i + 1) / assignments.length * 0.45,
      `${courseName}: Scanned ${i + 1}/${assignments.length} assignments`);
  }
  
  onProgress(1, `${courseName}: Found ${downloads.length} files`);
  return downloads;
}

async function fetchFileAsBlob(url, signal) {
  const response = await fetch(url, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return await response.blob();
}

async function startDownload(selectedCourses, user) {
  abortController = new AbortController();
  const signal = abortController.signal;
  
  setRunning(true);
  
  const tracker = new ProgressTracker();
  tracker.setPhases([
    { name: 'scan', weight: 30 },
    { name: 'download', weight: 70 }
  ]);
  
  try {
    // Phase 1: Collect all downloads
    tracker.setPhase(0);
    let allDownloads = [];
    
    for (let i = 0; i < selectedCourses.length; i++) {
      const course = selectedCourses[i];
      const downloads = await collectDownloads(course, user, signal, (p, text) => {
        const courseProgress = (i + p) / selectedCourses.length;
        tracker.update(courseProgress, text);
      });
      allDownloads = allDownloads.concat(downloads);
    }
    
    // Deduplicate
    const seen = new Set();
    allDownloads = allDownloads.filter(d => {
      if (seen.has(d.url)) return false;
      seen.add(d.url);
      return true;
    });
    
    if (allDownloads.length === 0) {
      setStatus('No files found in selected courses', 'error');
      setRunning(false);
      return;
    }
    
    // Phase 2: Download and zip
    tracker.setPhase(1);
    const zip = new JSZip();
    let downloaded = 0;
    let failed = 0;
    const totalFiles = allDownloads.length;
    
    for (const dl of allDownloads) {
      signal.throwIfAborted();
      
      const shortName = dl.filename.split('/').slice(-1)[0];
      tracker.update(
        downloaded / totalFiles,
        `Downloading ${downloaded + 1}/${totalFiles}: ${shortName}`
      );
      
      try {
        const blob = await fetchFileAsBlob(dl.url, signal);
        zip.file(dl.filename, blob);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn(`Failed to download ${dl.filename}:`, e);
        failed++;
      }
      
      downloaded++;
      await new Promise(r => setTimeout(r, 50));
    }
    
    signal.throwIfAborted();
    
    // Generate zip
    tracker.update(0.95, 'Generating ZIP file...');
    
    const zipBlob = await zip.generateAsync({ 
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    }, (metadata) => {
      tracker.update(0.95 + (metadata.percent / 100) * 0.05, 
        `Compressing: ${Math.round(metadata.percent)}%`);
    });
    
    // Download zip
    const zipUrl = URL.createObjectURL(zipBlob);
    const timestamp = new Date().toISOString().slice(0, 10);
    const zipName = selectedCourses.length === 1 
      ? `${sanitizeFilename(selectedCourses[0].name)}_${timestamp}.zip`
      : `Canvas_Courses_${timestamp}.zip`;
    
    chrome.runtime.sendMessage({
      action: 'download',
      url: zipUrl,
      filename: zipName
    });
    
    tracker.update(1, `Done! ${downloaded - failed} files in ZIP`);
    setStatus(
      failed > 0 
        ? `Downloaded ${downloaded - failed} files (${failed} failed)` 
        : `Downloaded ${downloaded} files`,
      'success'
    );
    
  } catch (e) {
    if (e.name === 'AbortError') {
      setStatus('Download cancelled', 'error');
      setProgress(0, 'Cancelled');
    } else {
      console.error(e);
      setStatus('Error: ' + e.message, 'error');
    }
  } finally {
    setRunning(false);
    abortController = null;
  }
}

function stopDownload() {
  if (abortController) {
    abortController.abort();
  }
}

async function checkDomain() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url) {
        resolve(tabs[0].url.startsWith('https://canvas.unl.edu'));
      } else {
        resolve(false);
      }
    });
  });
}

async function main() {
  try {
    // Check if we're on Canvas
    const onCanvas = await checkDomain();
    if (!onCanvas) {
      setStatus('Please navigate to canvas.unl.edu to use this extension.', 'error');
      return;
    }
    
    const user = await getCurrentUser();
    setStatus(`Connected as ${user.name}`, 'success');
    
    const courses = await getCourses();
    
    if (courses.length === 0) {
      setStatus('No courses found', 'error');
      return;
    }
    
    const listEl = document.getElementById('course-list');
    listEl.innerHTML = courses.map(c => `
      <div class="course-item">
        <input type="checkbox" id="course-${c.id}" value="${c.id}" checked>
        <label for="course-${c.id}">${c.name}</label>
      </div>
    `).join('');
    
    document.getElementById('course-section').style.display = 'block';
    
    document.getElementById('toggle-all').addEventListener('change', (e) => {
      document.querySelectorAll('#course-list input').forEach(cb => {
        cb.checked = e.target.checked;
      });
    });
    
    document.getElementById('download-btn').addEventListener('click', async () => {
      const selectedIds = Array.from(document.querySelectorAll('#course-list input:checked'))
        .map(cb => parseInt(cb.value));
      
      const selectedCourses = courses.filter(c => selectedIds.includes(c.id));
      
      if (selectedCourses.length === 0) {
        setStatus('Select at least one course', 'error');
        return;
      }
      
      await startDownload(selectedCourses, user);
    });
    
    document.getElementById('stop-btn').addEventListener('click', () => {
      stopDownload();
    });
    
  } catch (e) {
    console.error(e);
    if (e.message.includes('401') || e.message.includes('403')) {
      setStatus('Not logged in to Canvas. Please log in first.', 'error');
    } else {
      setStatus('Error: ' + e.message, 'error');
    }
  }
}

main();
