// Canvas API helper
const CANVAS_BASE = 'https://canvas.unl.edu';
const API_BASE = `${CANVAS_BASE}/api/v1`;

async function apiGet(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    credentials: 'include'
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}

// Paginated fetch - Canvas API uses Link headers
async function apiGetAll(endpoint) {
  let results = [];
  let url = `${API_BASE}${endpoint}`;
  
  while (url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    
    const data = await response.json();
    results = results.concat(data);
    
    // Parse Link header for next page
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

async function getCourses() {
  const courses = await apiGetAll('/courses?enrollment_state=active&include[]=term&per_page=50');
  return courses.filter(c => c.name);
}

async function getCourseFiles(courseId) {
  try {
    return await apiGetAll(`/courses/${courseId}/files?per_page=50`);
  } catch (e) {
    console.warn(`Could not get files for course ${courseId}:`, e);
    return [];
  }
}

async function getCourseFolders(courseId) {
  try {
    return await apiGetAll(`/courses/${courseId}/folders?per_page=50`);
  } catch (e) {
    console.warn(`Could not get folders for course ${courseId}:`, e);
    return [];
  }
}

async function getCourseModules(courseId) {
  try {
    return await apiGetAll(`/courses/${courseId}/modules?include[]=items&per_page=50`);
  } catch (e) {
    console.warn(`Could not get modules for course ${courseId}:`, e);
    return [];
  }
}

async function getCourseAssignments(courseId) {
  try {
    return await apiGetAll(`/courses/${courseId}/assignments?per_page=50`);
  } catch (e) {
    console.warn(`Could not get assignments for course ${courseId}:`, e);
    return [];
  }
}

async function getSubmission(courseId, assignmentId, userId) {
  try {
    return await apiGet(`/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`);
  } catch (e) {
    return null;
  }
}

async function getCurrentUser() {
  return await apiGet('/users/self');
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
    // phases: [{name, weight}]
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
    // progress: 0-1 within current phase
    this.phaseProgress = progress;
    const phase = this.phases[this.currentPhase];
    const overall = phase.start + (phase.end - phase.start) * progress;
    setProgress(Math.round(overall * 100), text);
  }
}

async function collectDownloads(course, user, onProgress) {
  const courseName = sanitizeFilename(course.name);
  const downloads = [];
  
  const folders = await getCourseFolders(course.id);
  
  // Files
  onProgress(0, `${courseName}: Scanning files...`);
  const files = await getCourseFiles(course.id);
  
  for (const file of files) {
    const folderPath = buildFolderPath(folders, file.folder_id);
    const path = folderPath 
      ? `${courseName}/Files/${folderPath}/${file.display_name}`
      : `${courseName}/Files/${file.display_name}`;
    downloads.push({ url: file.url, filename: path, size: file.size || 0 });
  }
  
  // Modules
  onProgress(0.33, `${courseName}: Scanning modules...`);
  const modules = await getCourseModules(course.id);
  
  for (const mod of modules) {
    const moduleName = sanitizeFilename(mod.name);
    if (!mod.items) continue;
    
    for (const item of mod.items) {
      if (item.type === 'File' && item.url) {
        try {
          const fileData = await apiGet(item.url.replace(API_BASE, ''));
          if (fileData.url) {
            downloads.push({
              url: fileData.url,
              filename: `${courseName}/Modules/${moduleName}/${fileData.display_name}`,
              size: fileData.size || 0
            });
          }
        } catch (e) {
          console.warn('Could not fetch module file:', e);
        }
      }
    }
  }
  
  // Assignments
  onProgress(0.66, `${courseName}: Scanning assignments...`);
  const assignments = await getCourseAssignments(course.id);
  
  for (const assignment of assignments) {
    const submission = await getSubmission(course.id, assignment.id, user.id);
    if (!submission || !submission.attachments) continue;
    
    const assignmentName = sanitizeFilename(assignment.name);
    for (const att of submission.attachments) {
      downloads.push({
        url: att.url,
        filename: `${courseName}/Assignments/${assignmentName}/${att.display_name}`,
        size: att.size || 0
      });
    }
  }
  
  onProgress(1, `${courseName}: Found ${downloads.length} files`);
  return downloads;
}

async function fetchFileAsBlob(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return await response.blob();
}

async function main() {
  try {
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
      
      document.getElementById('download-btn').disabled = true;
      document.getElementById('progress').style.display = 'block';
      
      const tracker = new ProgressTracker();
      
      // Phase 1: Scan (30%), Phase 2: Download & Zip (70%)
      tracker.setPhases([
        { name: 'scan', weight: 30 },
        { name: 'download', weight: 70 }
      ]);
      
      // Phase 1: Collect all downloads
      tracker.setPhase(0);
      let allDownloads = [];
      
      for (let i = 0; i < selectedCourses.length; i++) {
        const course = selectedCourses[i];
        const downloads = await collectDownloads(course, user, (p, text) => {
          const courseProgress = (i + p) / selectedCourses.length;
          tracker.update(courseProgress, text);
        });
        allDownloads = allDownloads.concat(downloads);
      }
      
      // Deduplicate by URL
      const seen = new Set();
      allDownloads = allDownloads.filter(d => {
        if (seen.has(d.url)) return false;
        seen.add(d.url);
        return true;
      });
      
      if (allDownloads.length === 0) {
        setStatus('No files found in selected courses', 'error');
        document.getElementById('download-btn').disabled = false;
        return;
      }
      
      // Phase 2: Download and add to zip
      tracker.setPhase(1);
      const zip = new JSZip();
      let downloaded = 0;
      let failed = 0;
      const totalFiles = allDownloads.length;
      
      for (const dl of allDownloads) {
        const shortName = dl.filename.split('/').slice(-1)[0];
        tracker.update(
          downloaded / totalFiles,
          `Downloading ${downloaded + 1}/${totalFiles}: ${shortName}`
        );
        
        try {
          const blob = await fetchFileAsBlob(dl.url);
          zip.file(dl.filename, blob);
        } catch (e) {
          console.warn(`Failed to download ${dl.filename}:`, e);
          failed++;
        }
        
        downloaded++;
        
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 50));
      }
      
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
      document.getElementById('download-btn').disabled = false;
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
