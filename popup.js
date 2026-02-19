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
  // Get all courses where we're a student or teacher
  const courses = await apiGetAll('/courses?enrollment_state=active&include[]=term&per_page=50');
  return courses.filter(c => c.name); // Filter out access-denied courses
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

async function downloadFile(url, filename) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'download', url, filename },
      (response) => resolve(response)
    );
  });
}

async function downloadCourse(course, user, onProgress) {
  const courseName = sanitizeFilename(course.name);
  const downloads = [];
  
  // Get folders for path building
  const folders = await getCourseFolders(course.id);
  
  // 1. Download files from Files section
  onProgress(`${courseName}: Fetching files...`);
  const files = await getCourseFiles(course.id);
  
  for (const file of files) {
    const folderPath = buildFolderPath(folders, file.folder_id);
    const path = folderPath 
      ? `${courseName}/Files/${folderPath}/${file.display_name}`
      : `${courseName}/Files/${file.display_name}`;
    downloads.push({ url: file.url, filename: path });
  }
  
  // 2. Download from modules
  onProgress(`${courseName}: Fetching modules...`);
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
              filename: `${courseName}/Modules/${moduleName}/${fileData.display_name}`
            });
          }
        } catch (e) {
          console.warn('Could not fetch module file:', e);
        }
      }
    }
  }
  
  // 3. Download assignment submissions
  onProgress(`${courseName}: Fetching assignments...`);
  const assignments = await getCourseAssignments(course.id);
  
  for (const assignment of assignments) {
    const submission = await getSubmission(course.id, assignment.id, user.id);
    if (!submission || !submission.attachments) continue;
    
    const assignmentName = sanitizeFilename(assignment.name);
    for (const att of submission.attachments) {
      downloads.push({
        url: att.url,
        filename: `${courseName}/Assignments/${assignmentName}/${att.display_name}`
      });
    }
  }
  
  return downloads;
}

async function main() {
  try {
    // Check if we can access Canvas API
    const user = await getCurrentUser();
    setStatus(`Connected as ${user.name}`, 'success');
    
    // Get courses
    const courses = await getCourses();
    
    if (courses.length === 0) {
      setStatus('No courses found', 'error');
      return;
    }
    
    // Render course list
    const listEl = document.getElementById('course-list');
    listEl.innerHTML = courses.map(c => `
      <div class="course-item">
        <input type="checkbox" id="course-${c.id}" value="${c.id}" checked>
        <label for="course-${c.id}">${c.name}</label>
      </div>
    `).join('');
    
    document.getElementById('course-section').style.display = 'block';
    
    // Toggle all handler
    document.getElementById('toggle-all').addEventListener('change', (e) => {
      document.querySelectorAll('#course-list input').forEach(cb => {
        cb.checked = e.target.checked;
      });
    });
    
    // Download handler
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
      
      let allDownloads = [];
      let completed = 0;
      
      // Collect all downloads
      for (const course of selectedCourses) {
        setProgress(
          (completed / selectedCourses.length) * 50,
          `Scanning ${course.name}...`
        );
        
        const downloads = await downloadCourse(course, user, (msg) => {
          document.getElementById('progress-text').textContent = msg;
        });
        allDownloads = allDownloads.concat(downloads);
        completed++;
      }
      
      // Deduplicate by URL
      const seen = new Set();
      allDownloads = allDownloads.filter(d => {
        if (seen.has(d.url)) return false;
        seen.add(d.url);
        return true;
      });
      
      // Download files
      let downloaded = 0;
      for (const dl of allDownloads) {
        setProgress(
          50 + (downloaded / allDownloads.length) * 50,
          `Downloading ${downloaded + 1}/${allDownloads.length}: ${dl.filename.split('/').pop()}`
        );
        
        await downloadFile(dl.url, dl.filename);
        downloaded++;
        
        // Small delay to avoid overwhelming
        await new Promise(r => setTimeout(r, 100));
      }
      
      setProgress(100, `Done! Downloaded ${downloaded} files.`);
      setStatus(`Downloaded ${downloaded} files`, 'success');
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
