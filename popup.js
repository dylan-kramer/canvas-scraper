// Popup UI - communicates with background worker

const CANVAS_BASE = 'https://canvas.unl.edu';
const API_BASE = `${CANVAS_BASE}/api/v1`;

let currentUser = null;
let courses = [];

async function apiGet(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`, { credentials: 'include' });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function apiGetAll(endpoint) {
  let results = [];
  let url = `${API_BASE}${endpoint}`;
  
  while (url) {
    const response = await fetch(url, { credentials: 'include' });
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

function updateUI(state) {
  const isRunning = state.running;
  const isDone = state.phase === 'done';
  const isError = state.phase === 'error';
  const isCancelled = state.phase === 'cancelled';
  
  // Show/hide buttons
  document.getElementById('download-btn').style.display = isRunning ? 'none' : 'block';
  document.getElementById('stop-btn').style.display = isRunning ? 'block' : 'none';
  document.getElementById('progress').style.display = (isRunning || isDone || isError || isCancelled) ? 'block' : 'none';
  
  // Disable course selection while running
  document.querySelectorAll('#course-list input').forEach(cb => {
    cb.disabled = isRunning;
  });
  const toggleAll = document.getElementById('toggle-all');
  if (toggleAll) toggleAll.disabled = isRunning;
  
  // Update progress
  setProgress(state.progress * 100, state.progressText || '');
  
  // Update status
  if (isError) {
    setStatus('Error: ' + state.error, 'error');
  } else if (isDone) {
    setStatus(`Downloaded ${state.downloadedFiles} files${state.failedFiles > 0 ? ` (${state.failedFiles} failed)` : ''}`, 'success');
  } else if (isCancelled) {
    setStatus('Download cancelled', 'error');
  } else if (isRunning) {
    setStatus('Downloading... (you can close this popup)', 'success');
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

async function getBackgroundState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
      resolve(response || { running: false, phase: 'idle' });
    });
  });
}

function startDownload(selectedCourses) {
  chrome.runtime.sendMessage({
    action: 'start',
    courses: selectedCourses,
    user: currentUser
  });
}

function stopDownload() {
  chrome.runtime.sendMessage({ action: 'stop' });
}

// Listen for state updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'stateUpdate') {
    updateUI(message.state);
  }
});

async function main() {
  try {
    // Check domain
    const onCanvas = await checkDomain();
    if (!onCanvas) {
      setStatus('Please navigate to canvas.unl.edu to use this extension.', 'error');
      return;
    }
    
    // Get current background state
    const state = await getBackgroundState();
    
    // If already running, just show progress
    if (state.running) {
      updateUI(state);
      // Still load courses in background
    }
    
    // Get user
    currentUser = await apiGet('/users/self');
    setStatus(`Connected as ${currentUser.name}`, 'success');
    
    // Get courses
    courses = await apiGetAll('/courses?enrollment_state=active&include[]=term&per_page=50');
    courses = courses.filter(c => c.name);
    
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
    
    // Toggle all
    document.getElementById('toggle-all').addEventListener('change', (e) => {
      document.querySelectorAll('#course-list input').forEach(cb => {
        cb.checked = e.target.checked;
      });
    });
    
    // Download button
    document.getElementById('download-btn').addEventListener('click', () => {
      const selectedIds = Array.from(document.querySelectorAll('#course-list input:checked'))
        .map(cb => parseInt(cb.value));
      
      const selectedCourses = courses.filter(c => selectedIds.includes(c.id));
      
      if (selectedCourses.length === 0) {
        setStatus('Select at least one course', 'error');
        return;
      }
      
      startDownload(selectedCourses);
    });
    
    // Stop button
    document.getElementById('stop-btn').addEventListener('click', () => {
      stopDownload();
    });
    
    // Update UI with current state
    updateUI(state);
    
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
