const { contextBridge, ipcRenderer } = require('electron');

// TODO: implement a channel filter
contextBridge.exposeInMainWorld('electron', {
  send: (channel, data) => {
    switch (channel.split(':').at(0)) {
      case 'command':
        throw new Error('not allowed');
      default:
        return ipcRenderer.send(channel, data);
    }
  },

  on: (channel, func) =>
    ipcRenderer.on(channel, (event, ...args) => func(...args)),

  invoke: (channel, ...args) =>
    ipcRenderer.invoke(channel, ...args),

  removeAllListeners: (channel) =>
    ipcRenderer.removeAllListeners(channel)
});