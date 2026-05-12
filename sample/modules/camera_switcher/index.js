const { processEvents, disconnect } = require('./src/data-processor');
const { setRaceLapCount } = require('./src/config');

let eventQueue = [];
let isProcessingEvent = false;
let currentStatus = {};
let statusChangeCallback = null;

function updateStatus(data) {
    currentStatus = { ...currentStatus, ...data };
    if (statusChangeCallback) statusChangeCallback(currentStatus);
}

async function eventProcessor() {
    if (isProcessingEvent || eventQueue.length === 0) return;
    isProcessingEvent = true;
    const event = eventQueue.shift();
    try {
        await processEvents(updateStatus, event);
    } catch (error) {
        console.error('[CameraSwitcher] processing error:', error);
    } finally {
        isProcessingEvent = false;
        if (eventQueue.length > 0) setImmediate(eventProcessor);
    }
}

async function triggerEvent(event) {
    eventQueue.push(event);
    if (!isProcessingEvent) setImmediate(eventProcessor);
}

function init() {
    console.log('[CameraSwitcher] init');
    triggerEvent({ type: 'initial' });
}

async function shutdown() {
    eventQueue.length = 0;
    statusChangeCallback = null;
    await disconnect();
}

module.exports = {
    init,
    triggerEvent,
    setRaceLapCount,
    shutdown,
    getStatus: () => currentStatus,
    onStatusChange: (cb) => { statusChangeCallback = cb; }
};
