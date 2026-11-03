// "Sync any video" (2.0): marks this tab's NetParty scripts as running on a page the user chose
// (injected after a click on "Sync this tab", or on a site they allowed). content.js then uses the
// generic video adapter in anyvideo.js instead of the Netflix / JioHotstar / YouTube / Prime Video ones.
window.__netpartyAny = true;
