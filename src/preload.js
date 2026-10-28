const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  loadFile: (filePath) => ipcRenderer.invoke('file:load', filePath),
  prefetch: (filePaths) => ipcRenderer.invoke('file:prefetch', filePaths),
  siblings: (filePath) => ipcRenderer.invoke('file:siblings', filePath),
  prepareVideo: (filePath, mode) => ipcRenderer.invoke('video:prepare', filePath, mode),
  cancelVideo: () => ipcRenderer.invoke('video:cancel'),
  saveAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
  showInFolder: (filePath) => ipcRenderer.invoke('file:showInFolder', filePath),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  onTranscodeProgress: (cb) => ipcRenderer.on('transcode:progress', (_e, info) => cb(info))
});
