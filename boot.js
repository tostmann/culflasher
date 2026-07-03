// Browser-Gate (klassisches Script, laeuft synchron vor dem App-Mount):
// WebUSB/WebSerial vorhanden? Sonst Hinweis einblenden und App verstecken.
// Ausgelagert aus index.html, damit die CSP ohne 'unsafe-inline' fuer
// script-src auskommt (siehe CSP-<meta> im <head>).
if (!('usb' in navigator) && !('serial' in navigator)) {
    document.getElementById('unsupported-browser').style.display = 'block';
    document.write('<style>#app { display: none !important; }</style>');
}
