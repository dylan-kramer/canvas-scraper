// Content script - runs on Canvas LMS sites
// Sends confirmation to popup that we're on a Canvas domain
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkDomain') {
    sendResponse({ 
      valid: true, 
      url: window.location.href,
      hostname: window.location.hostname
    });
  }
  return true;
});
