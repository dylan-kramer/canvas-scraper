# Canvas Scraper

A Chrome extension to download and archive files from any Canvas LMS instance.

## Features

- Downloads files from the Files section (preserving folder structure)
- Downloads module content and attachments
- Downloads assignment submission attachments
- Downloads discussion topic and entry attachments
- Downloads announcements (saved as HTML)
- Downloads course syllabus
- Organizes files by course name
- Select which courses to download
- Progress tracking with retry on failure
- Works with any Canvas LMS instance (not just canvas.unl.edu)

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right corner)
4. Click "Load unpacked"
5. Select the folder containing this extension

## Usage

1. Log in to your Canvas LMS instance (e.g., canvas.unl.edu, canvas.example.edu)
2. Navigate to any page within Canvas
3. Click the Canvas Scraper extension icon in your browser toolbar
4. Select the courses you want to download
5. Click "Scan Selected Courses" to preview files
6. Review the file count and estimated size
7. Click "Confirm Download" to start downloading
8. Files will be saved as a ZIP archive in your Downloads folder

## File Organization

```
Canvas/
├── Course Name/
│   ├── Files/
│   │   ├── folder1/
│   │   │   └── document.pdf
│   │   └── syllabus.pdf
│   ├── Modules/
│   │   ├── Week 1/
│   │   │   └── lecture.pdf
│   │   └── Week 2/
│   │       └── notes.pdf
│   ├── Assignments/
│   │   ├── Homework 1/
│   │   │   ├── Instructions/
│   │   │   │   └── homework.pdf
│   │   │   └── Submissions/
│   │   │       └── attempt_1/
│   │   │           └── my_submission.pdf
│   ├── Discussions/
│   │   └── Topic Title/
│   │       └── attachment.pdf
│   ├── Announcements/
│   │   └── Announcement Title.html
│   └── Syllabus.html
└── Another Course/
    └── ...
```

## Permissions

- **downloads**: Save files to your computer
- **storage**: Remember preferences and state
- **tabs**: Access current tab information
- **host_permissions (*://*/*)**: Access any Canvas LMS instance with your session

## Requirements

- Chrome browser (or Chromium-based browser)
- You must be logged into your Canvas instance
- Large courses may take several minutes to scan and download

## Tips

- Close other tabs to reduce memory usage during large downloads
- The extension works in the background - you can close the popup after starting
- If a download fails, it will automatically retry up to 3 times
- Files are deduplicated - same file in multiple locations won't be downloaded twice

## Troubleshooting

**"Please navigate to your Canvas LMS instance"**
- Make sure you are on a Canvas page before clicking the extension

**"Not logged in to Canvas"**
- Log out and log back in to Canvas, then try again

**No courses found**
- Make sure you have active enrollments in courses
- Check that your session hasn't expired

## Technical Details

- Manifest Version 3 (MV3) Chrome Extension
- Concurrent downloads (4 workers) for faster processing
- ZIP compression for efficient storage
- State persistence for recovery after browser restart
