import { useState, useEffect } from 'react';
import '../SidePanel.css';

interface WorkflowExportProps {
  onClose: () => void;
}

const WorkflowExport = ({ onClose }: WorkflowExportProps) => {
  const [workflowText, setWorkflowText] = useState<string>('Loading workflow data...');
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);

  // Function to fetch workflow data
  const fetchWorkflow = () => {
    console.log('Fetching workflow data');
    setIsLoading(true);
    setError(null);

    try {
      chrome.runtime.sendMessage({ action: 'getWorkflowSummary' }, response => {
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          console.error('Error fetching workflow:', lastError);
          setError(`Failed to fetch workflow: ${lastError.message}`);
          setWorkflowText('Error loading workflow data. Please try again.');
        } else if (response && response.workflow) {
          console.log('Received workflow data:', response.workflow.substring(0, 100) + '...');
          setWorkflowText(response.workflow);
        } else {
          console.log('No workflow data available in response:', response);
          setWorkflowText('No workflow data available.');
        }

        setIsLoading(false);
      });
    } catch (err) {
      console.error('Exception when fetching workflow:', err);
      setError(`Exception: ${err instanceof Error ? err.message : String(err)}`);
      setWorkflowText('Error loading workflow data. Please try again.');
      setIsLoading(false);
    }
  };

  // Set up initial loading of workflow
  useEffect(() => {
    console.log('WorkflowExport component mounted, requesting workflow data');
    fetchWorkflow();

    // Set up listener for workflow updates
    const handleWorkflowUpdate = (message: any) => {
      console.log('Received workflow update notification:', message);
      if (message.type === 'workflowUpdated' && autoRefresh) {
        console.log('Auto-refreshing workflow data');
        fetchWorkflow();
      }
    };

    // Connect to background script for updates
    const port = chrome.runtime.connect({ name: 'workflow-monitor' });
    port.onMessage.addListener(handleWorkflowUpdate);

    // Also listen for direct messages for updates
    const directMessageListener = (message: any, sender: any, sendResponse: any) => {
      if (message.action === 'workflowUpdated' && autoRefresh) {
        console.log('Received direct workflow update notification');
        fetchWorkflow();
        sendResponse({ status: 'refreshing' });
        return true;
      }
      return false;
    };

    chrome.runtime.onMessage.addListener(directMessageListener);

    // Clean up on unmount
    return () => {
      port.disconnect();
      chrome.runtime.onMessage.removeListener(directMessageListener);
    };
  }, [autoRefresh]); // Dependency on autoRefresh

  const copyToClipboard = () => {
    navigator.clipboard.writeText(workflowText).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  };

  const downloadWorkflow = () => {
    const blob = new Blob([workflowText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const refreshWorkflow = () => {
    // Force refresh the workflow data
    fetchWorkflow();

    // Also ask content scripts to update their workflow data
    chrome.runtime.sendMessage({ action: 'refreshWorkflow' });
  };

  const toggleAutoRefresh = () => {
    setAutoRefresh(!autoRefresh);
  };

  return (
    <div className="workflow-export">
      <div className="workflow-header">
        <h2>Recorded Workflow</h2>
        <button className="close-button" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="workflow-actions">
        <button onClick={copyToClipboard} className="action-button" disabled={isLoading}>
          {isCopied ? 'Copied!' : 'Copy to Clipboard'}
        </button>

        <button onClick={downloadWorkflow} className="action-button" disabled={isLoading}>
          Download as Text
        </button>

        <button onClick={refreshWorkflow} className="action-button" disabled={isLoading}>
          Refresh
        </button>

        <button
          onClick={toggleAutoRefresh}
          className={`action-button ${autoRefresh ? 'auto-refresh-on' : 'auto-refresh-off'}`}>
          {autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
        </button>
      </div>

      {error && <div className="workflow-error">{error}</div>}

      <div className="workflow-content">
        {isLoading ? <div className="loading-indicator">Loading workflow data...</div> : <pre>{workflowText}</pre>}
      </div>
    </div>
  );
};

export default WorkflowExport;
