// Content script - only runs on canvas.unl.edu
// Sends confirmation to popup that we're on the right domain
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkDomain') {
    sendResponse({ 
      valid: true, 
      url: window.location.href 
    });
  }
  return true;
});
