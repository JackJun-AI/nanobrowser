import 'webextension-polyfill';
import { agentModelStore, AgentNameEnum, generalSettingsStore, llmProviderStore } from '@extension/storage';
import BrowserContext from './browser/context';
import { Executor } from './agent/executor';
import { createLogger } from './log';
import { ExecutionState } from './agent/event/types';
import { createChatModel } from './agent/helper';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DEFAULT_AGENT_OPTIONS } from './agent/types';

// 引入测试脚本
// import './dom/history/test-compare';
// 导入DOM树差异比较功能
import { trackRealTimeDOMChanges } from './dom/history/test-dom-diff';

const logger = createLogger('background');

// 暴露到全局，方便从控制台调用
// 使用globalThis代替window，以兼容Service Worker环境
(globalThis as any).trackDOMChanges = async (delayMs = 10000) => {
  console.log(`将记录DOM树并在${delayMs / 1000}秒后比较变化...`);
  return trackRealTimeDOMChanges(delayMs);
};

const browserContext = new BrowserContext({});
let currentExecutor: Executor | null = null;
let currentPort: chrome.runtime.Port | null = null;

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

// Function to check if script is already injected
async function isScriptInjected(tabId: number): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Object.prototype.hasOwnProperty.call(window, 'buildDomTree'),
    });
    return results[0]?.result || false;
  } catch (err) {
    console.error('Failed to check script injection status:', err);
    return false;
  }
}

// // Function to inject the buildDomTree script
async function injectBuildDomTree(tabId: number) {
  try {
    // Check if already injected
    const alreadyInjected = await isScriptInjected(tabId);
    if (alreadyInjected) {
      console.log('Scripts already injected, skipping...');
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['buildDomTree.js'],
    });
    console.log('Scripts successfully injected');
  } catch (err) {
    console.error('Failed to inject scripts:', err);
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    await injectBuildDomTree(tabId);
  }
});

// Handle content script messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Message received in background:', message.action, sender.tab?.id);

  // Special handling for getWorkflowSummary requests from side panel
  if (message.action === 'getWorkflowSummary') {
    console.log('Handling getWorkflowSummary request');
    // Get the complete workflow summary across all tabs
    getAllWorkflowData()
      .then(workflow => {
        console.log(`Retrieved workflow data: ${workflow.length} items`);
        if (workflow.length > 0) {
          const workflowSummary = formatWorkflowToString(workflow);
          sendResponse({ workflow: workflowSummary });
        } else {
          sendResponse({ workflow: 'No workflow data available.' });
        }
      })
      .catch(error => {
        console.error('Failed to retrieve complete workflow:', error);
        logger.error('Failed to retrieve complete workflow:', error);
        sendResponse({ workflow: 'Error retrieving workflow data.' });
      });
    // Return true to indicate we will respond asynchronously
    return true;
  }

  // Handle getCurrentTabId requests
  if (message.action === 'getCurrentTabId') {
    if (sender.tab && sender.tab.id) {
      console.log(`Sending tab ID ${sender.tab.id} to content script`);
      sendResponse({ tabId: sender.tab.id });
    } else {
      console.log('No tab ID available for getCurrentTabId request');
      sendResponse({ tabId: null });
    }
    return true;
  }

  // Handle workflowUpdated event (real-time updates)
  if (message.action === 'workflowUpdated') {
    // Broadcast to all connected clients that workflow was updated
    console.log('Broadcasting workflow update to connected clients');
    broadcastWorkflowUpdate(message.data.timestamp);
    sendResponse({ status: 'broadcasted' });
    return true;
  }

  // Only process further messages from content scripts
  if (!sender.tab) {
    console.log('Ignoring message not from a tab (except special requests)');
    return false;
  }

  const tabId = sender.tab.id;
  if (!tabId) {
    console.log('Tab ID is undefined');
    return false;
  }

  switch (message.action) {
    case 'contentScriptLoaded':
      console.log(`Content script loaded notification from tab ${tabId}:`, message.data.url);
      logger.info(`Content script loaded on tab ${tabId}: ${message.data.url}`);
      sendResponse({ status: 'received' });
      break;

    case 'captureDOMSnapshot':
      console.log(`DOM snapshot request received from tab ${tabId}:`, message.data);
      // When a click event occurs, capture DOM snapshot
      handleDOMSnapshotRequest(tabId, message.data)
        .then(result => {
          console.log(`DOM snapshot captured successfully for tab ${tabId}`);
          logger.info(`DOM snapshot captured for tab ${tabId}:`, result);

          // Check if this snapshot resulted in a tab change
          detectTabChange(tabId, result.url);

          sendResponse({ status: 'captured', result });
        })
        .catch(error => {
          console.error(`Failed to capture DOM snapshot for tab ${tabId}:`, error);
          logger.error(`Failed to capture DOM snapshot for tab ${tabId}:`, error);
          sendResponse({ status: 'error', error: error.message });
        });
      break;

    case 'batchUploadEvents':
      // Process batch of events
      logger.info(`Received ${message.data.events.length} events from tab ${tabId}`);
      break;

    case 'storeWorkflow':
      // Store workflow data in extension storage
      storeWorkflowData(tabId, message.data.workflow)
        .then(() => {
          logger.info(`Stored workflow for tab ${tabId} (${message.data.workflow.length} steps)`);
          sendResponse({ status: 'stored' });

          // Broadcast update to connected clients
          broadcastWorkflowUpdate(Date.now());
        })
        .catch(error => {
          logger.error(`Failed to store workflow for tab ${tabId}:`, error);
          sendResponse({ status: 'error', error: error.message });
        });
      break;

    case 'getWorkflow':
      // Retrieve workflow data
      getWorkflowData(tabId)
        .then(workflow => {
          sendResponse({ workflow });
        })
        .catch(error => {
          logger.error(`Failed to retrieve workflow for tab ${tabId}:`, error);
          sendResponse({ workflow: [] });
        });
      break;

    default:
      console.log(`Unknown action received: ${message.action}`);
      break;
  }

  // Return true to indicate we will respond asynchronously
  return true;
});

/**
 * Track potential tab navigation
 */
async function detectTabChange(tabId: number, url: string): Promise<void> {
  try {
    // Get the tab's current URL
    const tab = await chrome.tabs.get(tabId);

    // If URL has changed, it might be a new tab or navigation
    if (tab.url !== url) {
      console.log(`Tab ${tabId} URL changed: ${url} -> ${tab.url}`);

      // Get workflow for this tab
      const workflow = await getWorkflowData(tabId);

      // If we have workflow steps, add a navigation step
      if (workflow.length > 0) {
        const latestStep = workflow[workflow.length - 1];

        // Add a navigation step
        workflow.push({
          action: `Navigated to new page`,
          pageState: `On page titled "${tab.title || 'Unknown'}"`,
          changes: [`URL changed from ${url} to ${tab.url}`],
          timestamp: Date.now(),
          url: tab.url || '',
        });

        // Save updated workflow
        await storeWorkflowData(tabId, workflow);
        console.log(`Added navigation step to workflow for tab ${tabId}`);

        // Broadcast update
        broadcastWorkflowUpdate(Date.now());
      }
    }
  } catch (error) {
    console.error('Error detecting tab change:', error);
  }
}

/**
 * Broadcast workflow updates to all connected clients
 */
function broadcastWorkflowUpdate(timestamp: number): void {
  // Use the existing side panel connection if available
  if (currentPort) {
    currentPort.postMessage({
      type: 'workflowUpdated',
      timestamp,
    });
    console.log('Sent workflow update notification to side panel');
  }
}

// Process DOM snapshot request
async function handleDOMSnapshotRequest(
  tabId: number,
  data: { x?: number; y?: number; url: string; eventId?: string },
): Promise<any> {
  const { captureDOMSnapshot } = await import('./dom/service');

  try {
    // Call the DOM snapshot function with coordinates
    const snapshot = await captureDOMSnapshot(tabId, {
      x: data.x,
      y: data.y,
    });

    // Log the data for now - in a real implementation, you would:
    // 1. Store this data for analysis
    // 2. Send it to a backend for processing with LLM
    // 3. Use it to build the user journey map

    // Send the semantic information back to the content script
    chrome.tabs
      .sendMessage(tabId, {
        action: 'domSnapshotData',
        data: {
          semanticInfo: snapshot.semanticInfo,
          nearbyText: snapshot.nearbyText,
          innerText: snapshot.innerText,
          eventId: data.eventId, // Pass back the event ID to correlate with the original event
        },
      })
      .catch(error => {
        logger.error('Error sending DOM snapshot data to content script:', error);
      });

    return snapshot;
  } catch (error) {
    logger.error('Error capturing DOM snapshot:', error);
    throw error;
  }
}

// Store workflow data for a specific tab
async function storeWorkflowData(tabId: number, workflow: any[]): Promise<void> {
  try {
    // Use chrome.storage.local to store workflow data
    const key = `workflow_${tabId}`;
    await chrome.storage.local.set({ [key]: workflow });

    // Also update the combined workflow data
    const result = await chrome.storage.local.get('all_workflows');
    const allWorkflows = result.all_workflows || {}; // 如果不存在，使用空对象作为默认值

    // 将当前标签页的工作流存储到合并数据中
    allWorkflows[tabId] = workflow;

    // 重新存储合并的工作流数据
    await chrome.storage.local.set({ all_workflows: allWorkflows });

    console.log(`Workflow data stored successfully for tab ${tabId}, length: ${workflow.length}`);
  } catch (error) {
    logger.error('Error storing workflow data:', error);
    throw error;
  }
}

// Retrieve workflow data for a specific tab
async function getWorkflowData(tabId: number): Promise<any[]> {
  try {
    const key = `workflow_${tabId}`;
    const result = await chrome.storage.local.get(key);
    return result[key] || [];
  } catch (error) {
    logger.error('Error retrieving workflow data:', error);
    return [];
  }
}

// Get combined workflow data from all tabs
async function getAllWorkflowData(): Promise<any[]> {
  try {
    const result = await chrome.storage.local.get('all_workflows');
    const allWorkflows = result.all_workflows || {};
    console.log('Retrieved all workflows data:', Object.keys(allWorkflows).length, 'tabs');

    // Flatten all workflows into a single array and sort by timestamp
    const flattened = Object.values(allWorkflows).flat() as any[];
    console.log('Flattened workflow data, total steps:', flattened.length);

    // 返回按时间戳排序的工作流
    return flattened.sort((a, b) => a.timestamp - b.timestamp);
  } catch (error) {
    logger.error('Error retrieving all workflow data:', error);
    return [];
  }
}

/**
 * Format workflow data as a human-readable string
 */
function formatWorkflowToString(workflow: any[]): string {
  if (!workflow || workflow.length === 0) {
    return 'No workflow data available.';
  }

  // Add a title and timestamp
  const title = 'User Workflow Recording';
  const timestamp = new Date().toLocaleString();

  // Create a header with metadata
  const header = [`${title}`, `Exported on: ${timestamp}`, `Total actions: ${workflow.length}`, '\n'].join('\n');

  const stepDescriptions = workflow
    .map(step => {
      const time = new Date(step.timestamp).toLocaleTimeString();

      // Special handling for different action types
      let actionDescription = step.action;
      let stateDescription = step.pageState;
      let changesDescription = '';

      // Handle scroll actions differently
      if (step.action && step.action.startsWith('Scrolled')) {
        // For scroll actions, focus on what became visible
        const meaningfulChanges =
          step.changes &&
          step.changes.filter(
            (change: string) =>
              // Filter for changes that indicate new content or elements
              change.includes('section') ||
              change.includes('heading') ||
              change.includes('Revealed') ||
              change.includes('button appeared') ||
              change.includes('link appeared') ||
              change.includes('product') ||
              change.includes('card') ||
              change.includes('image'),
          );

        if (meaningfulChanges && meaningfulChanges.length > 0) {
          // Use only the most important changes (max 2)
          changesDescription = `\n   Result: ${meaningfulChanges.slice(0, 2).join(', ')}`;
        } else if (step.changes && step.changes.length > 0) {
          // Fall back to the first change if no meaningful ones found
          changesDescription = `\n   Result: ${step.changes[0]}`;
        }
      } else {
        // For non-scroll actions, use existing changes logic but limit to most important
        if (step.changes && step.changes.length > 0) {
          // Filter to prioritize the most informative changes
          const priorityChanges = step.changes.filter(
            (change: string) =>
              change.includes('Modal') ||
              change.includes('Navigated') ||
              change.includes('form submitted') ||
              change.includes('button appeared') ||
              change.includes('link appeared'),
          );

          const changesToShow = priorityChanges.length > 0 ? priorityChanges.slice(0, 2) : step.changes.slice(0, 2);

          changesDescription = `\n   Changes: ${changesToShow.join(', ')}`;

          // If there are more changes, just mention the count
          if (step.changes.length > 2) {
            changesDescription += ` (${step.changes.length - 2} more changes)`;
          }
        }
      }

      // Add semantic context if available
      const context = step.semanticContext ? `\n   Context: ${step.semanticContext}` : '';

      // Add element semantic information if available, prioritizing the most useful info
      let elementInfo = '';
      if (step.elementInfo) {
        const info = step.elementInfo;
        const semanticDetails = [];

        // Prioritize the most descriptive fields
        if (info.labelText) semanticDetails.push(`Label: "${info.labelText}"`);
        if (info.ariaLabel) semanticDetails.push(`Aria-Label: "${info.ariaLabel}"`);
        if (info.innerText && info.innerText.length <= 50) semanticDetails.push(`Text: "${info.innerText}"`);

        // Only add type info if we have meaningful text
        if (semanticDetails.length > 0 && info.tagName) {
          semanticDetails.unshift(`Element: ${info.tagName}`);
        }

        // Add nearby text for context, trimmed to be concise
        if (info.nearbyText && info.nearbyText.length <= 100) {
          const trimmedText = info.nearbyText.length > 60 ? info.nearbyText.substring(0, 60) + '...' : info.nearbyText;
          semanticDetails.push(`Nearby Text: "${trimmedText}"`);
        }

        if (semanticDetails.length > 0) {
          elementInfo = `\n   Element Info: ${semanticDetails.join(', ')}`;
        }
      }

      // For scroll actions, add scroll-specific information to the output
      if (step.action && step.action.startsWith('Scrolled') && step.eventData?.scrollInfo) {
        const scrollInfo = step.eventData.scrollInfo;

        // Replace the generic elementInfo with more scroll-specific info
        elementInfo = `\n   Scroll Details: ${scrollInfo.direction} direction, ${Math.round(scrollInfo.distance)} pixels`;

        // Only include duration if it's significant
        if (scrollInfo.duration > 1.0) {
          elementInfo += `, ${scrollInfo.duration.toFixed(1)}s duration`;
        }
      }

      return `${time} - ${actionDescription}\n   ${stateDescription}${context}${changesDescription}${elementInfo}`;
    })
    .join('\n\n');

  return header + stepDescriptions;
}

// Listen for debugger detached event
// if canceled_by_user, remove the tab from the browser context
chrome.debugger.onDetach.addListener(async (source, reason) => {
  console.log('Debugger detached:', source, reason);
  if (reason === 'canceled_by_user') {
    if (source.tabId) {
      await browserContext.cleanup();
    }
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  browserContext.removeAttachedPage(tabId);
});

logger.info('background loaded');

// Listen for simple messages - forward to our content script handler if it has action property
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script messages are handled by the listener added above
  if (message.action && sender.tab) {
    // Already handled by the listener above
    return true;
  }

  // Handle other message types if needed in the future
  // Return false if response is not sent asynchronously
  return false;
});

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'side-panel-connection') {
    currentPort = port;

    port.onMessage.addListener(async message => {
      try {
        switch (message.type) {
          case 'heartbeat':
            // Acknowledge heartbeat
            port.postMessage({ type: 'heartbeat_ack' });
            break;

          case 'new_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: 'No task provided' });
            if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });

            logger.info('new_task', message.tabId, message.task);
            currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
            subscribeToExecutorEvents(currentExecutor);

            const result = await currentExecutor.execute();
            logger.info('new_task execution result', message.tabId, result);
            break;
          }
          case 'follow_up_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: 'No follow up task provided' });
            if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });

            logger.info('follow_up_task', message.tabId, message.task);

            // If executor exists, add follow-up task
            if (currentExecutor) {
              currentExecutor.addFollowUpTask(message.task);
              // Re-subscribe to events in case the previous subscription was cleaned up
              subscribeToExecutorEvents(currentExecutor);
              const result = await currentExecutor.execute();
              logger.info('follow_up_task execution result', message.tabId, result);
            } else {
              // executor was cleaned up, can not add follow-up task
              logger.info('follow_up_task: executor was cleaned up, can not add follow-up task');
              return port.postMessage({ type: 'error', error: 'Executor was cleaned up, can not add follow-up task' });
            }
            break;
          }

          case 'cancel_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: 'No task to cancel' });
            await currentExecutor.cancel();
            break;
          }

          case 'resume_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: 'No task to resume' });
            await currentExecutor.resume();
            return port.postMessage({ type: 'success' });
          }

          case 'pause_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: 'No task to pause' });
            await currentExecutor.pause();
            return port.postMessage({ type: 'success' });
          }

          case 'screenshot': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });
            const page = await browserContext.switchTab(message.tabId);
            const screenshot = await page.takeScreenshot();
            logger.info('screenshot', message.tabId, screenshot);
            return port.postMessage({ type: 'success', screenshot });
          }

          case 'state': {
            try {
              const browserState = await browserContext.getState();
              const elementsText = browserState.elementTree.clickableElementsToString(
                DEFAULT_AGENT_OPTIONS.includeAttributes,
              );

              logger.info('state', browserState);
              logger.info('interactive elements', elementsText);
              return port.postMessage({ type: 'success', msg: 'State printed to console' });
            } catch (error) {
              logger.error('Failed to get state:', error);
              return port.postMessage({ type: 'error', error: 'Failed to get state' });
            }
          }

          case 'nohighlight': {
            const page = await browserContext.getCurrentPage();
            await page.removeHighlight();
            return port.postMessage({ type: 'success', msg: 'highlight removed' });
          }

          default:
            return port.postMessage({ type: 'error', error: 'Unknown message type' });
        }
      } catch (error) {
        console.error('Error handling port message:', error);
        port.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('Side panel disconnected');
      currentPort = null;
    });
  }
});

async function setupExecutor(taskId: string, task: string, browserContext: BrowserContext) {
  const providers = await llmProviderStore.getAllProviders();
  // if no providers, need to display the options page
  if (Object.keys(providers).length === 0) {
    throw new Error('Please configure API keys in the settings first');
  }
  const agentModels = await agentModelStore.getAllAgentModels();
  // verify if every provider used in the agent models exists in the providers
  for (const agentModel of Object.values(agentModels)) {
    if (!providers[agentModel.provider]) {
      throw new Error(`Provider ${agentModel.provider} not found in the settings`);
    }
  }

  const navigatorModel = agentModels[AgentNameEnum.Navigator];
  if (!navigatorModel) {
    throw new Error('Please choose a model for the navigator in the settings first');
  }
  // Log the provider config being used for the navigator
  const navigatorProviderConfig = providers[navigatorModel.provider];
  const navigatorLLM = createChatModel(navigatorProviderConfig, navigatorModel);

  let plannerLLM: BaseChatModel | null = null;
  const plannerModel = agentModels[AgentNameEnum.Planner];
  if (plannerModel) {
    // Log the provider config being used for the planner
    const plannerProviderConfig = providers[plannerModel.provider];
    plannerLLM = createChatModel(plannerProviderConfig, plannerModel);
  }

  let validatorLLM: BaseChatModel | null = null;
  const validatorModel = agentModels[AgentNameEnum.Validator];
  if (validatorModel) {
    // Log the provider config being used for the validator
    const validatorProviderConfig = providers[validatorModel.provider];
    validatorLLM = createChatModel(validatorProviderConfig, validatorModel);
  }

  const generalSettings = await generalSettingsStore.getSettings();
  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    validatorLLM: validatorLLM ?? navigatorLLM,
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      maxFailures: generalSettings.maxFailures,
      maxActionsPerStep: generalSettings.maxActionsPerStep,
      useVision: generalSettings.useVision,
      useVisionForPlanner: generalSettings.useVisionForPlanner,
      planningInterval: generalSettings.planningInterval,
    },
  });

  return executor;
}

// Update subscribeToExecutorEvents to use port
async function subscribeToExecutorEvents(executor: Executor) {
  // Clear previous event listeners to prevent multiple subscriptions
  executor.clearExecutionEvents();

  // Subscribe to new events
  executor.subscribeExecutionEvents(async event => {
    try {
      if (currentPort) {
        currentPort.postMessage(event);
      }
    } catch (error) {
      logger.error('Failed to send message to side panel:', error);
    }

    if (
      event.state === ExecutionState.TASK_OK ||
      event.state === ExecutionState.TASK_FAIL ||
      event.state === ExecutionState.TASK_CANCEL
    ) {
      await currentExecutor?.cleanup();
    }
  });
}

// 当扩展加载时，会执行这个文件
console.log('扩展后台脚本已加载，您可以在控制台输入 trackDOMChanges(10000) 来跟踪DOM变化（参数为延迟毫秒数）');
