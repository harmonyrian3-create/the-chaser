// --- THEME SYSTEM (Optimized for no flash) ---

// Default themes
const THEMES = {
  dark: [
    { id: 'dark-default', name: 'Dark Default', bg: '#0f172a', text: '#f1f5f9', card: '#1e293b', border: '#334155' },
    { id: 'dark-star', name: '⭐ Starry Night', bg: '#0b0e1a', text: '#e2e8f0', card: '#141b2d', border: '#2d3b55' },
    { id: 'dark-city', name: '🌃 City Lights', bg: '#0a0e17', text: '#e8edf5', card: '#131d2e', border: '#1f2d44' },
    { id: 'dark-forest', name: '🌲 Forest Dark', bg: '#0d1a0f', text: '#d4e8d4', card: '#1a2e1a', border: '#2a452a' },
    { id: 'dark-ocean', name: '🌊 Ocean Deep', bg: '#0a121f', text: '#c8dce8', card: '#12243a', border: '#1a3450' },
    { id: 'dark-matrix', name: '💚 Matrix', bg: '#0a0f0a', text: '#00ff41', card: '#0f1a0f', border: '#1a331a' },
    { id: 'dark-royal', name: '👑 Royal Dark', bg: '#0d081a', text: '#e8d8f5', card: '#1a0f30', border: '#2d1a50' }
  ],
  light: [
    { id: 'light-default', name: 'Light Default', bg: '#f1f5f9', text: '#0f172a', card: '#ffffff', border: '#e2e8f0' },
    { id: 'light-sunset', name: '🌅 Sunset Glow', bg: '#fdf0e6', text: '#4a2c1a', card: '#fffaf5', border: '#f5e0d0' },
    { id: 'light-ocean', name: '🌊 Ocean Breeze', bg: '#e8f4f8', text: '#0a2a3a', card: '#f5faff', border: '#d0e8f0' },
    { id: 'light-forest', name: '🌲 Forest Mist', bg: '#eaf5ea', text: '#1a3a1a', card: '#f5faf5', border: '#d0e8d0' },
    { id: 'light-rose', name: '🌹 Rose Petal', bg: '#fdf0f2', text: '#4a1a2a', card: '#fffafb', border: '#f5dce0' },
    { id: 'light-lavender', name: '💜 Lavender', bg: '#f5f0fa', text: '#2a1a4a', card: '#fcfaff', border: '#e8d8f0' },
    { id: 'light-amber', name: '🟡 Amber Glow', bg: '#fdf8ee', text: '#4a3a1a', card: '#fffcf5', border: '#f5ecda' }
  ]
};

// Accent colors
const ACCENTS = [
  { id: 'blue', name: 'Blue', color: '#3b82f6' },
  { id: 'purple', name: 'Purple', color: '#8b5cf6' },
  { id: 'pink', name: 'Pink', color: '#ec4899' },
  { id: 'red', name: 'Red', color: '#ef4444' },
  { id: 'orange', name: 'Orange', color: '#f97316' },
  { id: 'yellow', name: 'Yellow', color: '#eab308' },
  { id: 'green', name: 'Green', color: '#22c55e' },
  { id: 'teal', name: 'Teal', color: '#14b8a6' },
  { id: 'indigo', name: 'Indigo', color: '#6366f1' }
];

// --- Apply theme synchronously (no flash) ---
function applyThemeSync(themeId, mode, accentId, customBg) {
  const theme = mode === 'dark' 
    ? THEMES.dark.find(t => t.id === themeId) || THEMES.dark[0]
    : THEMES.light.find(t => t.id === themeId) || THEMES.light[0];
  
  const accent = ACCENTS.find(a => a.id === accentId) || ACCENTS[0];
  
  // Apply directly to document.documentElement (root)
  const root = document.documentElement;
  root.style.setProperty('--bg-color', theme.bg);
  root.style.setProperty('--text-color', theme.text);
  root.style.setProperty('--card-color', theme.card);
  root.style.setProperty('--border-color', theme.border);
  root.style.setProperty('--accent-color', accent.color);
  
  if (customBg) {
    root.style.setProperty('--custom-bg', `url(${customBg})`);
    root.style.setProperty('--bg-image', 'var(--custom-bg)');
  } else {
    root.style.setProperty('--bg-image', 'none');
  }
  
  // Also apply to body
  document.body.style.backgroundColor = theme.bg;
  document.body.style.color = theme.text;
  document.body.style.backgroundImage = customBg ? `url(${customBg})` : 'none';
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundAttachment = 'fixed';
}

// --- Load theme from localStorage (sync, no flash) ---
function loadThemeSync() {
  try {
    const saved = JSON.parse(localStorage.getItem('chaser_theme'));
    if (saved) {
      applyThemeSync(saved.themeId, saved.mode, saved.accentId, saved.customBg);
      return saved;
    } else {
      // Default: Dark Default + Blue accent
      applyThemeSync('dark-default', 'dark', 'blue', null);
      return { themeId: 'dark-default', mode: 'dark', accentId: 'blue' };
    }
  } catch (e) {
    applyThemeSync('dark-default', 'dark', 'blue', null);
    return { themeId: 'dark-default', mode: 'dark', accentId: 'blue' };
  }
}

// --- Apply theme (async version for settings page) ---
function applyTheme(themeId, mode, accentId, customBg) {
  applyThemeSync(themeId, mode, accentId, customBg);
  // Save to localStorage
  localStorage.setItem('chaser_theme', JSON.stringify({ themeId, mode, accentId, customBg }));
}

// --- Load theme (async version for settings page) ---
function loadTheme() {
  return loadThemeSync();
}

// --- Custom background upload ---
function uploadCustomBg(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    const saved = JSON.parse(localStorage.getItem('chaser_theme')) || { themeId: 'dark-default', mode: 'dark', accentId: 'blue' };
    saved.customBg = dataUrl;
    localStorage.setItem('chaser_theme', JSON.stringify(saved));
    applyThemeSync(saved.themeId, saved.mode, saved.accentId, dataUrl);
    const preview = document.getElementById('customBgPreview');
    if (preview) preview.src = dataUrl;
    document.getElementById('bgUploadStatus').innerHTML = '<span class="text-green-500">✅ Background uploaded!</span>';
  };
  reader.readAsDataURL(file);
}

// --- Remove custom background ---
function removeCustomBg() {
  const saved = JSON.parse(localStorage.getItem('chaser_theme')) || { themeId: 'dark-default', mode: 'dark', accentId: 'blue' };
  delete saved.customBg;
  localStorage.setItem('chaser_theme', JSON.stringify(saved));
  applyThemeSync(saved.themeId, saved.mode, saved.accentId, null);
  const preview = document.getElementById('customBgPreview');
  if (preview) preview.src = '';
  document.getElementById('bgUploadStatus').innerHTML = '<span class="text-gray-500">Background removed.</span>';
}

// --- Get current theme settings ---
function getThemeSettings() {
  try {
    return JSON.parse(localStorage.getItem('chaser_theme')) || { themeId: 'dark-default', mode: 'dark', accentId: 'blue' };
  } catch { return { themeId: 'dark-default', mode: 'dark', accentId: 'blue' }; }
}

// --- Load theme on page load (runs instantly) ---
loadThemeSync();