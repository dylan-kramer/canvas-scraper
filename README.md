# Canvas Scraper

Chrome extension to download all files from Canvas LMS courses for archival.

## Features

- Downloads all files from the Files section (preserving folder structure)
- Downloads module content/attachments
- Downloads assignment submission attachments
- Organizes by course name
- Select which courses to download
- Progress tracking

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select this folder

## Usage

1. Log in to [Canvas](https://canvas.unl.edu)
2. Click the Canvas Scraper extension icon
3. Select courses to download
4. Click "Download Selected Courses"
5. Files will be saved to your Downloads folder under `Canvas/`

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
│   └── Assignments/
│       └── Homework 1/
│           └── my_submission.pdf
└── Another Course/
    └── ...
```

## Permissions

- **downloads**: Save files to your computer
- **storage**: Remember preferences
- **activeTab**: Access Canvas when you click the extension
- **host_permissions (canvas.unl.edu)**: Access Canvas API with your session

## Notes

- You must be logged into Canvas for this to work
- Large courses may take several minutes
- Files are deduplicated (won't download same file twice)
