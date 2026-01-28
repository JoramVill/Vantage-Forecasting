"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    // Existing methods
    runCommand: (command, args) => electron_1.ipcRenderer.invoke('run-command', command, args),
    selectFile: (options) => electron_1.ipcRenderer.invoke('select-file', options),
    selectDirectory: () => electron_1.ipcRenderer.invoke('select-directory'),
    saveFile: (options) => electron_1.ipcRenderer.invoke('save-file', options),
    getAppPath: () => electron_1.ipcRenderer.invoke('get-app-path'),
    // Settings methods
    loadSettings: () => electron_1.ipcRenderer.invoke('load-settings'),
    saveSettings: (settings) => electron_1.ipcRenderer.invoke('save-settings', settings),
    // Chat methods
    sendChatMessage: (message, history) => electron_1.ipcRenderer.invoke('send-chat-message', message, history)
});
