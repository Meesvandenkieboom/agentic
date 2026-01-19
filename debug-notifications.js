/**
 * Notification System Debug Script
 * Paste this entire script into your browser console to diagnose notification issues
 */

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔍 NOTIFICATION SYSTEM DEBUG');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 1. Browser Support
console.log('\n📱 1. BROWSER SUPPORT');
console.log('  Notification API available:', 'Notification' in window);
console.log('  ServiceWorker available:', 'serviceWorker' in navigator);

// 2. Permission Status
console.log('\n🔐 2. PERMISSION STATUS');
if ('Notification' in window) {
  console.log('  Browser permission:', Notification.permission);
} else {
  console.log('  ❌ Notifications not supported');
}

// 3. LocalStorage State
console.log('\n💾 3. LOCALSTORAGE STATE');
const notifPref = localStorage.getItem('agentic-notifications-enabled');
console.log('  agentic-notifications-enabled:', notifPref === null ? 'null (not set)' : notifPref);
console.log('  Parsed as boolean:', notifPref === 'true');

// 4. Document State
console.log('\n📄 4. DOCUMENT STATE');
console.log('  visibilityState:', document.visibilityState);
console.log('  hasFocus():', document.hasFocus());
console.log('  hidden:', document.hidden);

// 5. Test helper functions (recreate them here)
console.log('\n🧪 5. TESTING HELPER FUNCTIONS');

function areNotificationsEnabled() {
  if (typeof window === 'undefined') return false;
  const preference = localStorage.getItem('agentic-notifications-enabled');
  if (preference === null && 'Notification' in window) {
    return Notification.permission === 'granted';
  }
  return preference === 'true';
}

function canShowNotifications() {
  return 'Notification' in window && Notification.permission === 'granted' && areNotificationsEnabled();
}

function isTabFocused() {
  return document.visibilityState === 'visible';
}

console.log('  areNotificationsEnabled():', areNotificationsEnabled());
console.log('  canShowNotifications():', canShowNotifications());
console.log('  isTabFocused():', isTabFocused());

// 6. Test notification creation
console.log('\n🔔 6. TESTING NOTIFICATION CREATION');

if (!canShowNotifications()) {
  console.log('  ❌ canShowNotifications() returned false');
  console.log('  ⚠️  Cannot proceed with notification test');

  // Show what's blocking it
  if (!('Notification' in window)) {
    console.log('  ❌ BLOCKER: Notification API not available');
  }
  if ('Notification' in window && Notification.permission !== 'granted') {
    console.log('  ❌ BLOCKER: Browser permission not granted:', Notification.permission);
  }
  if (!areNotificationsEnabled()) {
    console.log('  ❌ BLOCKER: User preference disabled in localStorage');
  }
} else {
  console.log('  ✅ All checks passed, attempting to create notification...');

  try {
    const testNotif = new Notification('Debug Test', {
      body: 'If you see this, notification creation works!',
      tag: 'debug-test',
      icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAGzSURBVFhH7ZY9SgNBFMf/k0gsfEJrwUorC1/AwsLKB7CwsLCw0UJrGysfwMJKO7G0srCwsLCw0s7CRhsLLbQIJCHJrtzA7OzO7I9ZCfiBgWHn3nvmzNy5s/BPfQEtYBe4Ah6BD+C7wPVeAjaBCnAKvCWB14FFYAFoAFfAc0zAMzANrAErwBywHhfwBLSBQ+AQWI0L6AATwBqwAqwC8yEBHWAXOAN2gMW4gF6gH1gDloF5YDYk4B04Bm6BA2A+JOAHGALWgQVgFpgJCXgDjoBH4ACYCQnQMTgC3oC9kIAfYBTYBBaBaWAq5P4N6AaugBNgPuT+HRgDNoB5YBKoB92/As/AB7AHzITcfwAXgAbeBORiAtT8BnADHAJTcQE1RYCauxtz/wF0gQ/gJCD/KSCgCjwAV0A7JKAO3AId4Aw4DglQk3PAA3AKtEMC2sA10AEugJOQgJpS4B14Bi5D7gfABNABboDjkICaov4eWAYmgYmQ+1tgEqgD7cD9KzACNIG7gPu+5r4P3AfcfwHrQAu4C7h/BUZA/T8HPv0H8QvxW/zb3mU7JAAAAABJRU5ErkJggg==',
    });

    console.log('  ✅ Notification created successfully!');
    console.log('  Notification object:', testNotif);

    testNotif.onclick = () => {
      console.log('  🖱️ Notification clicked!');
      window.focus();
      testNotif.close();
    };

    testNotif.onshow = () => {
      console.log('  👁️ Notification shown!');
    };

    testNotif.onerror = (e) => {
      console.error('  ❌ Notification error:', e);
    };

    testNotif.onclose = () => {
      console.log('  ❌ Notification closed');
    };

  } catch (error) {
    console.error('  ❌ Error creating notification:', error);
  }
}

// 7. Check if there are any global overrides or blocking scripts
console.log('\n⚙️ 7. CHECKING FOR OVERRIDES');
console.log('  window.Notification:', typeof window.Notification);
console.log('  Notification.prototype:', Notification.prototype);

// 8. Summary
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 SUMMARY');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const issues = [];

if (!('Notification' in window)) {
  issues.push('❌ Notification API not available in browser');
}

if ('Notification' in window && Notification.permission !== 'granted') {
  issues.push('❌ Browser permission: ' + Notification.permission);
}

if (!areNotificationsEnabled()) {
  issues.push('❌ User preference disabled (localStorage)');
}

if (issues.length > 0) {
  console.log('⚠️  ISSUES FOUND:');
  issues.forEach(issue => console.log('  ' + issue));

  console.log('\n💡 FIXES:');
  if ('Notification' in window && Notification.permission !== 'granted') {
    console.log('  Run: await Notification.requestPermission()');
  }
  if (!areNotificationsEnabled()) {
    console.log('  Run: localStorage.setItem("agentic-notifications-enabled", "true")');
  }
} else {
  console.log('✅ All checks passed! Notification should have been created above.');
  console.log('   If you didn\'t see a notification, check your OS settings.');
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
