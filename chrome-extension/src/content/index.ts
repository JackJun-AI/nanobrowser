import { createLogger } from '@src/background/log';

const logger = createLogger('EventListener');

console.log('Content script loaded and logger initialized');

interface EventData {
  type: string;
  target: {
    tagName: string;
    id: string;
    className: string;
    text: string;
    xpath: string;
    isInteractive: boolean; // Is element interactive
    role: string; // ARIA role or semantic role
    semanticType: string; // Button, link, input, etc.
  };
  timestamp: number;
  url: string;
  x?: number;
  y?: number;
  value?: string;
  scrollInfo?: {
    startY: number;
    endY: number;
    direction: string;
    distance: number;
    duration: number;
  };
}

// Workflow recording in natural language
interface WorkflowStep {
  action: string; // Natural language description of the action
  pageState: string; // Natural language description of the page state
  changes: string[]; // Natural language descriptions of important changes
  timestamp: number;
  url: string;
  semanticContext?: string; // Added semantic context about what was clicked
  elementInfo?: {
    // Additional semantic information about the element
    tagName: string;
    id: string;
    className: string;
    ariaLabel: string;
    labelText: string;
    nearbyText: string; // Nearby text content for context
    innerText: string; // Inner text of the element
  };
  eventData?: EventData; // Original event data for additional context
}

// Store the complete workflow history
const workflowHistory: WorkflowStep[] = [];

// Store DOM state for comparison
let previousDomState: DomState | null = null;

// Store the most recent DOM snapshot data
let lastDomSnapshotData: {
  semanticInfo: {
    tagName: string;
    id: string;
    className: string;
    ariaLabel: string;
    placeholder: string;
    alt: string;
    labelText: string;
  };
  nearbyText: string;
  innerText: string;
} | null = null;

// Queue to store events before sending to background
let eventQueue: EventData[] = [];
const MAX_QUEUE_SIZE = 50;
const BATCH_UPLOAD_INTERVAL = 3000; // 3 seconds

// Time to wait before capturing DOM changes after a click
const DOM_CHANGE_TIMEOUT = 10000; // 10 seconds

// Keep track of DOM change timeout
let domChangeTimeoutId: number | null = null;

// Track if we're waiting for DOM changes
let waitingForDomChanges = false;

// Track the last click time for any click
let lastClickTime = 0;

// Track the tab ID
let currentTabId: number | null = null;

// Track scroll state
let scrollState = {
  isScrolling: false,
  scrollStartY: 0,
  scrollStartX: 0,
  scrollDebounceTimeout: null as number | null,
  lastRecordedScrollY: 0,
  scrollDirection: '',
  scrollDistance: 0,
  scrollStartTime: 0,
  newlyVisibleElements: {
    interactive: [] as { element: HTMLElement; text: string; type: string }[],
    headings: [] as { element: HTMLElement; text: string }[],
  },
  previousMarkdownSnapshot: '',
  markdownDifferences: [] as string[],
};

// Enhanced DOM state interface
interface DomState {
  url: string;
  title: string;
  headings: string[];
  interactiveElements: string[];
  visibleElements: string[]; // Elements visible in the viewport
  formStates: FormState[]; // Form states
  navigationState: string; // Location info
  modals: string[]; // Modal dialogs that are open
  tabId?: number; // Current tab ID
  markdownContent: string; // Markdown representation of visible content
}

// Form state interface
interface FormState {
  id: string;
  action: string;
  fields: {
    name: string;
    type: string;
    value: string;
  }[];
  context: string; // Form semantic context
}

// Track the last recorded action and scroll direction for better change detection
let lastRecordedAction = '';
let lastRecordedScrollDirection = '';

/**
 * Get XPath for an element
 */
function getXPath(element: Element): string {
  if (!element) return '';

  // If element has ID, return a direct XPath
  if (element.id) {
    return `//*[@id="${element.id}"]`;
  }

  // Otherwise build path
  const paths: string[] = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 0;
    let sibling = current.previousElementSibling;

    while (sibling) {
      if (sibling.tagName === current.tagName) {
        index++;
      }
      sibling = sibling.previousElementSibling;
    }

    const tagName = current.tagName.toLowerCase();
    const pathIndex = index ? `[${index + 1}]` : '';
    paths.unshift(`${tagName}${pathIndex}`);

    // Move up to parent
    if (current.parentElement) {
      current = current.parentElement;
    } else {
      break;
    }
  }

  return '/' + paths.join('/');
}

/**
 * Check if an element is interactive
 */
function isInteractiveElement(element: HTMLElement): boolean {
  // Direct interactive elements
  if (
    element instanceof HTMLAnchorElement ||
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLOptionElement
  ) {
    return true;
  }

  // Elements with ARIA roles
  const role = element.getAttribute('role');
  if (role && ['button', 'link', 'checkbox', 'menuitem', 'tab', 'radio'].includes(role)) {
    return true;
  }

  // Elements with click event handlers (approximate check)
  if (element.hasAttribute('onclick') || element.hasAttribute('ng-click') || element.hasAttribute('@click')) {
    return true;
  }

  // Elements that commonly have JS event handlers
  if (
    element.classList.contains('btn') ||
    element.classList.contains('button') ||
    element.classList.contains('clickable') ||
    element.classList.contains('nav-item')
  ) {
    return true;
  }

  // Element has pointer cursor
  const computedStyle = window.getComputedStyle(element);
  if (computedStyle.cursor === 'pointer') {
    return true;
  }

  return false;
}

/**
 * Get the semantic type of an element
 */
function getSemanticType(element: HTMLElement): string {
  if (element instanceof HTMLAnchorElement) return 'link';
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLInputElement) {
    return element.type || 'input';
  }
  if (element instanceof HTMLSelectElement) return 'select';
  if (element instanceof HTMLTextAreaElement) return 'textarea';
  if (element instanceof HTMLOptionElement) return 'option';

  // Check ARIA role
  const role = element.getAttribute('role');
  if (role) return role;

  // Check class names for semantic clues
  if (element.classList.contains('btn') || element.classList.contains('button')) return 'button';
  if (element.classList.contains('nav') || element.classList.contains('menu')) return 'navigation';
  if (element.classList.contains('card')) return 'card';
  if (element.classList.contains('modal')) return 'modal';

  // Default to tag name
  return element.tagName.toLowerCase();
}

/**
 * Process an event and prepare it for the queue
 */
function processEvent(event: Event): EventData | null {
  console.log('Processing event:', event.type, event.target);

  const target = event.target as HTMLElement;
  if (!target || !(target instanceof HTMLElement)) {
    console.log('Target is not an HTMLElement, skipping event');
    return null;
  }

  // Skip events on extension elements
  if (target.closest('[id^="browser-user-highlight-"]')) {
    console.log('Skipping event on extension element');
    return null;
  }

  // For click events, only process interactive elements
  if (event.type === 'click' && !isInteractiveElement(target)) {
    console.log('Skipping click on non-interactive element:', target.tagName);
    // Try to find closest interactive parent
    const interactiveParent = target.closest('a, button, [role="button"], [role="link"], .btn, .button');
    if (interactiveParent && interactiveParent instanceof HTMLElement) {
      console.log('Found interactive parent, using instead:', interactiveParent.tagName);
      // Use the interactive parent instead
      return processEvent({ ...event, target: interactiveParent } as Event);
    }
    return null;
  }

  // Update last click time for any click (even non-interactive)
  if (event.type === 'click') {
    lastClickTime = Date.now();
  }

  // Extract ARIA role or semantic role
  const role = target.getAttribute('role') || '';

  const eventData: EventData = {
    type: event.type,
    target: {
      tagName: target.tagName.toLowerCase(),
      id: target.id || '',
      className: target.className || '',
      text: target.textContent?.trim().substring(0, 100) || '',
      xpath: getXPath(target),
      isInteractive: isInteractiveElement(target),
      role: role,
      semanticType: getSemanticType(target),
    },
    timestamp: Date.now(),
    url: window.location.href,
  };

  // Add event-specific data
  if (event instanceof MouseEvent) {
    eventData.x = event.clientX;
    eventData.y = event.clientY;
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    // For privacy concerns, we can anonymize the value
    // For example with a simple algorithm that keeps format but replaces chars
    if (target.type === 'password') {
      eventData.value = '********';
    } else {
      eventData.value = target.value.substring(0, 50);
    }
  }

  console.log('Event processed successfully:', event.type);
  return eventData;
}

/**
 * Convert an event to a natural language description
 */
function eventToNaturalLanguage(event: EventData): string {
  const eventType = event.type;
  const tagName = event.target.tagName;
  const text = event.target.text;
  const id = event.target.id;
  const semanticType = event.target.semanticType;
  const role = event.target.role;

  // Format based on event type and semantic information
  switch (eventType) {
    case 'click':
      // Check for special buttons first
      if (text.toLowerCase().includes('add to cart')) {
        return `Added item to cart using button "${text}"`;
      } else if (text.toLowerCase().includes('buy now')) {
        return `Initiated immediate purchase using "${text}" button`;
      } else if (text.toLowerCase().includes('checkout')) {
        return `Proceeded to checkout using "${text}" button`;
      } else if (text.toLowerCase().includes('submit') || text.toLowerCase().includes('send')) {
        return `Submitted information using "${text}" button`;
      } else if (text.toLowerCase().includes('search')) {
        return `Initiated search using "${text}" button`;
      } else if (text.toLowerCase().includes('login') || text.toLowerCase().includes('sign in')) {
        return `Attempted to log in using "${text}" button`;
      } else if (text.toLowerCase().includes('register') || text.toLowerCase().includes('sign up')) {
        return `Attempted to register using "${text}" button`;
      }

      // Standard patterns
      if (semanticType === 'button') {
        return `Clicked button ${text ? `"${text}"` : `(${id || 'unnamed'})`}`;
      } else if (semanticType === 'link') {
        return `Clicked link ${text ? `"${text}"` : `(${id || 'unnamed'})`}`;
      } else if (semanticType === 'checkbox' || (tagName === 'input' && event.value === 'checkbox')) {
        return `${event.value === 'true' ? 'Checked' : 'Unchecked'} checkbox ${id ? `"${id}"` : ''}`;
      } else if (semanticType === 'radio') {
        return `Selected radio option ${text || id || ''}`;
      } else if (semanticType === 'tab' || role === 'tab') {
        return `Switched to tab "${text}"`;
      } else if (semanticType === 'menu' || semanticType === 'menuitem' || role === 'menuitem') {
        return `Selected menu item "${text}"`;
      } else if (semanticType === 'dropdown' || role === 'combobox') {
        return `Clicked dropdown ${text ? `"${text}"` : ''}`;
      } else if (semanticType.includes('card') || tagName.includes('card')) {
        return `Selected card "${text || 'unnamed'}"`;
      } else {
        return `Clicked on ${semanticType} ${text ? `"${text}"` : ''}`;
      }

    case 'input':
    case 'change':
      if (event.value) {
        if (event.value === '********') {
          return `Entered password in ${semanticType}${id ? ` (${id})` : ''}`;
        } else if (semanticType === 'checkbox') {
          return `${event.value === 'true' ? 'Checked' : 'Unchecked'} ${id ? `"${id}"` : 'checkbox'}`;
        } else if (semanticType === 'radio') {
          return `Selected radio option ${id || ''}`;
        } else if (semanticType === 'select') {
          return `Selected "${event.value}" from dropdown${id ? ` (${id})` : ''}`;
        } else if (
          semanticType === 'search' ||
          id.includes('search') ||
          (tagName === 'input' && event.target.id.includes('search'))
        ) {
          return `Searched for "${event.value}"`;
        } else if (semanticType === 'email' || (tagName === 'input' && event.target.id.includes('email'))) {
          return `Entered email address in field${id ? ` (${id})` : ''}`;
        } else if (semanticType === 'tel' || (tagName === 'input' && event.target.id.includes('phone'))) {
          return `Entered phone number in field${id ? ` (${id})` : ''}`;
        } else if (semanticType === 'textarea' || tagName === 'textarea') {
          return `Entered text in text area${id ? ` (${id})` : ''}`;
        } else {
          return `Entered text "${event.value}" in ${semanticType}${id ? ` (${id})` : ''}`;
        }
      } else {
        return `Changed ${semanticType}${id ? ` (${id})` : ''}`;
      }

    case 'scroll':
      // If we have detailed scroll info, use it to create a more descriptive message
      if (event.scrollInfo) {
        const info = event.scrollInfo;

        if (info.direction === 'to top') {
          return 'Scrolled to the top of the page';
        } else if (info.direction === 'to bottom') {
          return 'Scrolled to the bottom of the page';
        } else if (info.direction === 'up') {
          const viewportHeight = window.innerHeight;
          if (info.distance > viewportHeight * 2) {
            return `Scrolled up significantly (${Math.round(info.distance)} pixels)`;
          } else if (info.distance > viewportHeight) {
            return 'Scrolled up about one page';
          } else {
            return `Scrolled up ${Math.round(info.distance)} pixels`;
          }
        } else if (info.direction === 'down') {
          const viewportHeight = window.innerHeight;
          if (info.distance > viewportHeight * 2) {
            return `Scrolled down significantly (${Math.round(info.distance)} pixels)`;
          } else if (info.distance > viewportHeight) {
            return 'Scrolled down about one page';
          } else {
            return `Scrolled down ${Math.round(info.distance)} pixels`;
          }
        }

        // Add duration for longer scrolls
        if (info.duration > 1.5) {
          return `Scrolled ${info.direction} ${Math.round(info.distance)} pixels over ${info.duration.toFixed(1)} seconds`;
        }
      }

      // Default scroll description if we don't have detailed info
      return 'Scrolled the page';

    case 'keydown':
      // We could enhance this to capture specific key presses if needed
      return 'Pressed key';

    default:
      return `Performed ${eventType} on ${semanticType}`;
  }
}

/**
 * Get semantic context of the clicked element
 */
function getSemanticContext(element: HTMLElement): string {
  // Find container or section
  const section = element.closest('section, article, [role="region"], [role="article"], .section, .container');
  const header = section?.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim();

  // Look for form context
  const form = element.closest('form');
  const formId = form?.id || form?.getAttribute('name') || '';
  const formAction = form?.getAttribute('action') || '';
  const formHeading = form?.querySelector('h1, h2, h3, legend, .form-title')?.textContent?.trim();

  // Look for dialog/modal context
  const modal = element.closest('[role="dialog"], .modal, .dialog');
  const modalTitle = modal?.querySelector('[role="heading"], .modal-title, h1, h2, h3')?.textContent?.trim();

  // Look for navigation context
  const navigation = element.closest('nav, [role="navigation"], .navigation, .menu');
  const navLabel =
    navigation?.getAttribute('aria-label') || navigation?.querySelector('h2, h3, .nav-title')?.textContent?.trim();

  // Look for list context
  const list = element.closest('ul, ol, [role="list"]');
  const listLabel = list?.getAttribute('aria-label') || list?.previousElementSibling?.textContent?.trim();

  // Look for table context
  const table = element.closest('table, [role="table"]');
  const tableCaption =
    table?.querySelector('caption')?.textContent?.trim() ||
    table?.getAttribute('aria-label') ||
    table?.previousElementSibling?.textContent?.trim();

  // Look for special UI patterns
  const card = element.closest('.card, .product-item, .item-card');
  const cardTitle = card?.querySelector('h2, h3, h4, .card-title')?.textContent?.trim();

  const tab = element.closest('.tab, [role="tab"]');
  const tabPanel = tab ? document.querySelector(`#${tab.getAttribute('aria-controls')}`) : null;
  const tabLabel = tab?.textContent?.trim();

  // Compose context
  let context = '';

  if (modalTitle) {
    context += `Within modal "${modalTitle}". `;
  }

  if (header) {
    context += `In section "${header}". `;
  }

  if (form) {
    const formType = formHeading || formId;
    context += `In form${formType ? ` "${formType}"` : ''}${formAction ? ` with action "${formAction}"` : ''}.`;
  }

  if (navLabel) {
    context += `In navigation menu "${navLabel}". `;
  }

  if (listLabel) {
    context += `In list "${listLabel}". `;
  }

  if (tableCaption) {
    context += `In table "${tableCaption}". `;
  }

  if (cardTitle) {
    context += `On card "${cardTitle}". `;
  }

  if (tabLabel) {
    context += `On tab "${tabLabel}". `;
  }

  return context.trim();
}

/**
 * Capture the current state of the DOM with enhanced semantic information
 */
function captureDomState(): DomState {
  const url = window.location.href;
  const title = document.title;

  // Get all headings
  const headings: string[] = [];
  document.querySelectorAll('h1, h2, h3').forEach(heading => {
    const text = heading.textContent?.trim();
    if (text) headings.push(text);
  });

  // Get important interactive elements with better semantic classification
  const interactiveElements: string[] = [];
  document
    .querySelectorAll(
      'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"]',
    )
    .forEach(element => {
      if (!(element instanceof HTMLElement)) return;

      // Get basic info
      const text = element.textContent?.trim() || (element as HTMLInputElement).placeholder || '';
      const id = element.id;
      let type = getSemanticType(element as HTMLElement);

      // Enhance semantic type with more context
      let semanticDescription = type;

      // Check for important UI patterns
      if (
        element.classList.contains('submit') ||
        element.getAttribute('type') === 'submit' ||
        text.toLowerCase().includes('submit') ||
        text.toLowerCase().includes('save') ||
        text.toLowerCase().includes('continue')
      ) {
        semanticDescription = 'submit button';
      } else if (
        text.toLowerCase().includes('add to cart') ||
        element.classList.contains('add-to-cart') ||
        element.getAttribute('data-action') === 'add-to-cart'
      ) {
        semanticDescription = 'add to cart button';
      } else if (text.toLowerCase().includes('buy now') || element.classList.contains('buy-now')) {
        semanticDescription = 'buy now button';
      } else if (
        element.closest('.pagination') ||
        (element.closest('[role="navigation"]') && (text === '>' || text === '<' || !isNaN(parseInt(text))))
      ) {
        semanticDescription = 'pagination control';
      } else if (element.getAttribute('aria-haspopup') === 'true' || element.classList.contains('dropdown-toggle')) {
        semanticDescription = 'dropdown trigger';
      }

      // Add context for form fields
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        const label = element.labels?.[0]?.textContent?.trim() || '';
        const name = element.name || '';
        // Check for placeholder attribute (not available on select elements)
        const placeholder =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.placeholder || ''
            : '';
        const fieldDescription = label || name || placeholder;

        if (fieldDescription) {
          semanticDescription = `${type}: "${fieldDescription}"`;
        }
      }

      if (text || id) {
        interactiveElements.push(`${semanticDescription}${text ? `: "${text}"` : ''}${id ? ` (ID: ${id})` : ''}`);
      }
    });

  // Get visible elements in viewport with better semantic context
  const visibleElements: string[] = [];
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  document
    .querySelectorAll(
      'h1, h2, h3, p, img, button, a, div.card, article, section, [role="button"], [data-testid], [aria-label]',
    )
    .forEach(element => {
      if (!(element instanceof HTMLElement)) return;

      const rect = element.getBoundingClientRect();

      // Check if element is in viewport
      if (rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0) {
        const text = element.textContent?.trim().substring(0, 100) || '';
        let tag = element.tagName.toLowerCase();
        const id = element.id;
        const dataTestId = element.getAttribute('data-testid');
        const ariaLabel = element.getAttribute('aria-label');

        // Add more semantic context based on custom attributes
        let semanticTag = tag;
        if (dataTestId) {
          semanticTag = `${tag}[${dataTestId}]`;
        } else if (ariaLabel) {
          semanticTag = `${tag}[${ariaLabel}]`;
        } else if (element.classList.contains('card') || element.classList.contains('product')) {
          semanticTag = 'product-card';
        } else if (element.classList.contains('alert') || element.classList.contains('notification')) {
          semanticTag = 'notification';
        } else if (element.classList.contains('banner') || element.classList.contains('hero')) {
          semanticTag = 'banner';
        }

        if (text) {
          visibleElements.push(`${semanticTag}${text ? `: "${text}"` : ''}${id ? ` (ID: ${id})` : ''}`);
        } else if (element instanceof HTMLImageElement) {
          const alt = element.alt || '';
          const src = element.src.split('/').pop() || 'image';
          visibleElements.push(`img: "${alt || src}"`);
        }
      }
    });

  // Capture form states with enhanced semantic context
  const formStates: FormState[] = [];
  document.querySelectorAll('form').forEach(form => {
    const formId = form.id || form.getAttribute('name') || '';
    const formAction = form.getAttribute('action') || '';

    // Try to determine form purpose
    let formContext = '';
    const formHeading = form.querySelector('h1, h2, h3, legend, .form-title')?.textContent?.trim();

    if (formHeading) {
      formContext = formHeading;
    } else if (formId.includes('search') || form.classList.contains('search-form')) {
      formContext = 'Search form';
    } else if (formId.includes('login') || form.classList.contains('login-form')) {
      formContext = 'Login form';
    } else if (formId.includes('register') || form.classList.contains('register-form')) {
      formContext = 'Registration form';
    } else if (formId.includes('checkout') || form.classList.contains('checkout-form')) {
      formContext = 'Checkout form';
    } else if (formId.includes('contact') || form.classList.contains('contact-form')) {
      formContext = 'Contact form';
    } else if (form.querySelector('input[type="password"]')) {
      formContext = 'Authentication form';
    }

    const fields: { name: string; type: string; value: string }[] = [];
    form.querySelectorAll('input, select, textarea').forEach(field => {
      if (!(field instanceof HTMLElement)) return;

      // Get enhanced field name with label if available
      const fieldElement = field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const label = fieldElement.labels?.[0]?.textContent?.trim();
      const name = fieldElement.name || fieldElement.id || '';
      const type = fieldElement.type || fieldElement.tagName.toLowerCase();

      // Add more semantic context to field name
      const semanticName = label || name;

      // Skip password fields for privacy
      if (type === 'password') {
        fields.push({ name: semanticName, type, value: '********' });
      } else if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        fields.push({ name: semanticName, type, value: field.value.substring(0, 50) });
      } else if (field instanceof HTMLSelectElement) {
        // For select elements, also include the selected option text when possible
        const selectedOption = field.options[field.selectedIndex];
        const displayValue = selectedOption ? selectedOption.text : field.value;
        fields.push({ name: semanticName, type, value: displayValue });
      }
    });

    formStates.push({
      id: formId,
      action: formAction,
      fields,
      context: formContext,
    });
  });

  // Get modal dialogs with enhanced context
  const modals: string[] = [];
  document.querySelectorAll('[role="dialog"], .modal, .dialog, [aria-modal="true"]').forEach(modal => {
    if (!(modal instanceof HTMLElement)) return;

    // Check if modal is visible (approximate check)
    const style = window.getComputedStyle(modal);
    if (style.display !== 'none' && style.visibility !== 'hidden') {
      // Look for heading or title
      const title = modal.querySelector('[role="heading"], .modal-title, h1, h2, h3')?.textContent?.trim();

      // Try to determine modal purpose from class names or attributes
      let modalType = '';
      if (modal.classList.contains('login-modal') || modal.querySelector('input[type="password"]')) {
        modalType = 'Login';
      } else if (modal.classList.contains('alert-modal') || modal.classList.contains('notification')) {
        modalType = 'Alert';
      } else if (modal.classList.contains('confirm-modal') || modal.querySelector('button.confirm')) {
        modalType = 'Confirmation';
      } else if (modal.classList.contains('product-modal') || modal.querySelector('.product-details')) {
        modalType = 'Product details';
      } else if (modal.classList.contains('video-modal') || modal.querySelector('video, iframe')) {
        modalType = 'Media viewer';
      }

      modals.push(`${modalType ? modalType + ': ' : ''}${title || 'Unnamed modal'}`);
    }
  });

  // Capture navigation state
  const navigationState = `${document.location.pathname}${document.location.search}`;

  // Get tab ID from the background script
  return {
    url,
    title,
    headings,
    interactiveElements,
    visibleElements,
    formStates,
    navigationState,
    modals,
    tabId: currentTabId || undefined,
    markdownContent:
      visibleElements.join('\n') +
      '\n' +
      headings.join('\n') +
      '\n' +
      formStates.map(form => form.context).join('\n') +
      '\n' +
      modals.join('\n'),
  };
}

/**
 * Compare current DOM state with previous state and return important changes with enhanced semantics
 */
function detectDomChanges(currentState: DomState): string[] {
  if (!previousDomState) {
    return ['Initial page load'];
  }

  const changes: string[] = [];

  // Check for navigation
  const navigationChange = detectNavigation(currentState, previousDomState);
  if (navigationChange) {
    changes.push(navigationChange);
    // If there was a full navigation, don't bother with detailed element comparisons
    if (navigationChange.startsWith('Navigated to')) {
      return [navigationChange];
    }
  }

  // Tab changes
  if (currentState.tabId !== previousDomState.tabId) {
    changes.push(`Switched to tab ID: ${currentState.tabId}`);
  }

  // Title change
  if (currentState.title !== previousDomState.title) {
    changes.push(`Page title changed to "${currentState.title}"`);
  }

  // Check for form submissions
  const formSubmission = detectFormSubmission(currentState, previousDomState);
  if (formSubmission) {
    changes.push(formSubmission);
  }

  // Check for modal dialogs that appeared - with null safety
  const prevModals = previousDomState.modals || [];
  const newModals = currentState.modals.filter(m => !prevModals.includes(m));
  if (newModals.length > 0) {
    changes.push(`Modal dialog appeared: "${newModals[0]}"`);
  }

  // Modal dialogs that disappeared - with null safety
  const closedModals = prevModals.filter(m => !currentState.modals.includes(m));
  if (closedModals.length > 0) {
    changes.push(`Modal dialog closed: "${closedModals[0]}"`);
  }

  // Check if this was a scroll action and provide more specific information
  if (lastRecordedAction && lastRecordedAction.startsWith('Scroll')) {
    const scrollChanges = detectScrollSpecificChanges(currentState, previousDomState);
    if (scrollChanges.length > 0) {
      // For scrolls, we want to focus only on what was revealed by scrolling
      return scrollChanges;
    }
  }

  // New headings (likely new content) - with null safety
  const prevHeadings = previousDomState.headings || [];
  const newHeadings = currentState.headings.filter(h => !prevHeadings.includes(h));
  if (newHeadings.length > 0) {
    // Limit to most important headings (first 3)
    const headingsToShow = newHeadings.slice(0, 3);
    changes.push(
      `New content appeared with heading${headingsToShow.length > 1 ? 's' : ''}: "${headingsToShow.join('", "')}"`,
    );

    // If there are more headings, just mention the count
    if (newHeadings.length > 3) {
      changes.push(`And ${newHeadings.length - 3} more new sections`);
    }
  }

  // Identify important new interactive elements - with null safety
  const prevInteractiveElements = previousDomState.interactiveElements || [];
  const newElements = currentState.interactiveElements.filter(el => !prevInteractiveElements.includes(el));

  if (newElements.length > 0) {
    // Find buttons, links, and form elements specifically
    const newButtons = newElements.filter(el => el.startsWith('button') || el.includes('[role="button"]'));
    const newLinks = newElements.filter(el => el.startsWith('a:') || el.includes('[role="link"]'));
    const newFormElements = newElements.filter(
      el => el.startsWith('input') || el.startsWith('select') || el.startsWith('textarea'),
    );

    // Report important interactive elements more specifically
    if (newButtons.length > 0) {
      // Show specific important buttons (first 2-3)
      const importantButtons = newButtons.slice(0, 2);
      changes.push(
        `New button${importantButtons.length > 1 ? 's' : ''} appeared: ${importantButtons.join(', ')}${newButtons.length > 2 ? ` and ${newButtons.length - 2} more...` : ''}`,
      );
    }

    if (newLinks.length > 0) {
      const importantLinks = newLinks.slice(0, 2);
      changes.push(
        `New link${importantLinks.length > 1 ? 's' : ''} appeared: ${importantLinks.join(', ')}${newLinks.length > 2 ? ` and ${newLinks.length - 2} more...` : ''}`,
      );
    }

    if (newFormElements.length > 0) {
      changes.push(
        `New form element${newFormElements.length > 1 ? 's' : ''} appeared: ${newFormElements.length > 2 ? `${newFormElements.length} fields including ` : ''}${newFormElements.slice(0, 2).join(', ')}`,
      );
    }

    // If there are other interactive elements but we haven't reported them specifically
    const reportedElements = newButtons.length + newLinks.length + newFormElements.length;
    if (reportedElements < newElements.length && reportedElements > 0) {
      changes.push(`${newElements.length - reportedElements} other interactive elements appeared`);
    } else if (reportedElements === 0 && newElements.length > 5) {
      // Fall back to count only if we couldn't identify specific types and there are many
      changes.push(`${newElements.length} new interactive elements appeared`);
    }
  }

  // Check for new visible elements that might be important content
  const prevVisibleElements = previousDomState.visibleElements || [];
  const newVisibleElements = currentState.visibleElements.filter(el => !prevVisibleElements.includes(el));

  if (newVisibleElements.length > 0) {
    // Extract interesting content categories
    const newImages = newVisibleElements.filter(el => el.startsWith('img:'));
    const newParagraphs = newVisibleElements.filter(el => el.startsWith('p:'));
    const newSections = newVisibleElements.filter(
      el => el.startsWith('section:') || el.startsWith('article:') || el.startsWith('div.card'),
    );

    // Report meaningful content changes
    if (newImages.length > 0) {
      changes.push(`${newImages.length} new image${newImages.length > 1 ? 's' : ''} appeared`);
    }

    if (newSections.length > 0) {
      changes.push(`${newSections.length} new content section${newSections.length > 1 ? 's' : ''} loaded`);
    }

    if (newParagraphs.length > 3) {
      changes.push(`${newParagraphs.length} new text paragraph${newParagraphs.length > 1 ? 's' : ''} loaded`);
    }

    // If we haven't reported specific content types but there are many new elements
    const reportedVisibleElements =
      newImages.length + newSections.length + (newParagraphs.length > 3 ? newParagraphs.length : 0);
    if (reportedVisibleElements === 0 && newVisibleElements.length > 10) {
      changes.push(`Content updated with significant changes (${newVisibleElements.length} new elements)`);
    }
  }

  // Check for disappeared elements (could indicate panels closing or content removal)
  const disappearedElements = (previousDomState.visibleElements || []).filter(
    el => !currentState.visibleElements.includes(el),
  );

  if (disappearedElements.length > 10 && changes.length === 0) {
    changes.push(`Content removed from page (${disappearedElements.length} elements)`);
  }

  // If no specific changes detected but we know something changed
  if (changes.length === 0 && currentState.url === previousDomState.url) {
    // Check if there's a significant change in the number of visible elements
    const elemDiff = Math.abs(currentState.visibleElements.length - (previousDomState.visibleElements?.length || 0));

    if (elemDiff > 5) {
      // Try to identify what kind of change it might be
      if (currentState.visibleElements.length > (previousDomState.visibleElements?.length || 0)) {
        changes.push(`New content loaded (${elemDiff} elements)`);
      } else {
        changes.push(`Content collapsed or removed (${elemDiff} elements)`);
      }
    } else {
      changes.push('Minor page update');
    }
  }

  return changes;
}

/**
 * Detect specific changes related to a scroll action
 */
function detectScrollSpecificChanges(currentState: DomState, previousState: DomState): string[] {
  // First try to use markdown comparison for richer content detection
  const markdownDifferences = compareMarkdownContent(currentState.markdownContent, previousState.markdownContent);

  // If markdown comparison yielded meaningful results, use them
  if (markdownDifferences.length > 0) {
    console.log('Detected markdown differences:', markdownDifferences);
    return markdownDifferences;
  }

  // Fall back to traditional element comparison if markdown didn't yield results
  console.log('No markdown differences detected, falling back to element comparison');

  const changes: string[] = [];

  // Get elements that became visible after scrolling
  const prevVisibleElements = previousState.visibleElements || [];
  const newVisibleElements = currentState.visibleElements.filter(el => !prevVisibleElements.includes(el));

  if (newVisibleElements.length === 0) {
    return ['No significant content revealed by scrolling'];
  }

  // Analyze what types of elements became visible

  // 1. Look for important headings that indicate sections
  const headings = newVisibleElements.filter(
    el => el.startsWith('h1:') || el.startsWith('h2:') || el.startsWith('h3:'),
  );

  if (headings.length > 0) {
    const headingTexts = headings
      .map(h => {
        const match = h.match(/: "([^"]*)"/);
        return match ? match[1] : '';
      })
      .filter(Boolean)
      .slice(0, 2);

    if (headingTexts.length > 0) {
      changes.push(
        `Revealed section${headingTexts.length > 1 ? 's' : ''}: "${headingTexts.join('", "')}"${headings.length > 2 ? ` and ${headings.length - 2} more` : ''}`,
      );
    }
  }

  // 2. Look for important interactive elements (buttons, links)
  const interactiveElements = newVisibleElements.filter(el => {
    // Focus on the most action-oriented elements
    return (
      el.includes('button') ||
      el.includes('[role="button"]') ||
      el.includes('submit') ||
      el.includes('add to cart') ||
      el.includes('buy now') ||
      el.includes('checkout')
    );
  });

  if (interactiveElements.length > 0) {
    const elementTexts = interactiveElements
      .map(e => {
        const match = e.match(/: "([^"]*)"/);
        return match ? match[1] : e;
      })
      .filter(Boolean)
      .slice(0, 2);

    if (elementTexts.length > 0) {
      changes.push(
        `Revealed interactive element${elementTexts.length > 1 ? 's' : ''}: "${elementTexts.join('", "')}"${interactiveElements.length > 2 ? ` and ${interactiveElements.length - 2} more` : ''}`,
      );
    }
  }

  // If we didn't identify any specific interesting elements, provide a generic summary
  if (changes.length === 0) {
    if (newVisibleElements.length > 5) {
      // Just mention the count of new elements
      changes.push(`Revealed ${newVisibleElements.length} new element${newVisibleElements.length > 1 ? 's' : ''}`);
    } else {
      changes.push('Minor content changes revealed by scrolling');
    }
  }

  return changes;
}

/**
 * Detect page navigation
 */
function detectNavigation(current: DomState, previous: DomState): string | null {
  // Complete URL change
  if (current.url !== previous.url) {
    // Check if it's a hash change only
    const prevUrlBase = previous.url.split('#')[0];
    const currUrlBase = current.url.split('#')[0];

    if (prevUrlBase !== currUrlBase) {
      // Try to provide context about the navigation
      const fromPath = new URL(previous.url).pathname;
      const toPath = new URL(current.url).pathname;

      // Check for common navigation patterns
      if (fromPath.includes('/product/') && toPath.includes('/checkout/')) {
        return `Navigated from product page to checkout`;
      } else if (fromPath.includes('/search') && toPath.includes('/product/')) {
        return `Navigated from search results to product page`;
      } else if (fromPath.includes('/cart') && toPath.includes('/checkout/')) {
        return `Navigated from cart to checkout`;
      } else if (fromPath.includes('/login') && toPath === '/') {
        return `Logged in and navigated to homepage`;
      } else if (fromPath === '/' && toPath.includes('/login')) {
        return `Navigated to login page`;
      } else {
        // Default navigation description
        return `Navigated from ${fromPath} to ${toPath}`;
      }
    } else {
      return `Jumped to section on the same page`;
    }
  }

  // Hash navigation within the same page
  if (current.navigationState !== previous.navigationState) {
    // Check for query parameter changes (possible filtering)
    if (current.navigationState.includes('?') && previous.navigationState.includes('?')) {
      // Try to identify what parameters changed
      const prevParams = new URLSearchParams(previous.navigationState.split('?')[1]);
      const currParams = new URLSearchParams(current.navigationState.split('?')[1]);

      // Check if sorting or filtering parameters changed
      if (prevParams.get('sort') !== currParams.get('sort')) {
        return `Changed sorting order to "${currParams.get('sort') || 'default'}"`;
      } else if (prevParams.get('filter') !== currParams.get('filter')) {
        return `Applied filter: "${currParams.get('filter') || 'unknown'}"`;
      } else if (prevParams.get('page') !== currParams.get('page')) {
        return `Navigated to page ${currParams.get('page') || 'unknown'}`;
      } else {
        return `Applied filters to the page`;
      }
    }

    // Check if it's tab navigation within the page
    if (current.navigationState.includes('#tab-') || current.navigationState.includes('#panel-')) {
      const tabId = current.navigationState.split('#')[1];
      return `Switched to ${tabId.replace('-', ' ')}`;
    }

    return `Changed page state to ${current.navigationState}`;
  }

  return null;
}

/**
 * Check for form submissions
 */
function detectFormSubmission(current: DomState, previous: DomState): string | null {
  // Check forms in previous state that are no longer present or have changed
  for (const prevForm of previous.formStates) {
    // Look for the same form in current state
    const currentForm = current.formStates.find(f => f.id === prevForm.id);

    // Form no longer exists or has been reset
    if (!currentForm) {
      // Try to identify what kind of form was submitted based on its fields or ID
      if (prevForm.id.includes('login') || prevForm.fields.some(f => f.name.includes('password'))) {
        return `Login form submitted`;
      } else if (
        prevForm.id.includes('search') ||
        prevForm.fields.some(f => f.name.includes('search') || f.name.includes('query'))
      ) {
        return `Search query submitted`;
      } else if (
        prevForm.id.includes('checkout') ||
        prevForm.fields.some(f => f.name.includes('payment') || f.name.includes('credit'))
      ) {
        return `Checkout form submitted`;
      } else if (
        prevForm.action.includes('subscribe') ||
        prevForm.fields.some(f => f.name.includes('email') && !f.name.includes('login'))
      ) {
        return `Email subscription form submitted`;
      } else {
        return `Form "${prevForm.id || 'unnamed'}" was submitted`;
      }
    }

    // Check if form fields were populated and now are empty (form submit)
    const prevHadValues = prevForm.fields.some(f => f.value && f.value !== '********');
    const currentEmpty = currentForm.fields.every(f => !f.value || f.value === '********');

    if (prevHadValues && currentEmpty) {
      // Try to provide more context about what kind of form was submitted
      const formFields = prevForm.fields.map(f => f.name).join(', ');
      let formType = 'unknown type';

      if (formFields.includes('email') && formFields.includes('password')) {
        formType = 'login';
      } else if (formFields.includes('search') || formFields.includes('query')) {
        formType = 'search';
      } else if (formFields.includes('address') || formFields.includes('payment')) {
        formType = 'checkout';
      } else if (formFields.includes('comment') || formFields.includes('message')) {
        formType = 'comment';
      }

      return `${formType.charAt(0).toUpperCase() + formType.slice(1)} form "${prevForm.id || 'unnamed'}" was submitted`;
    }
  }

  return null;
}

/**
 * Record a workflow step
 */
function recordWorkflowStep(action: string, eventData: EventData, forceDomSnapshot = false) {
  console.log('Recording workflow step:', action);

  // Capture the current DOM state
  const currentDomState = captureDomState();

  // Get semantic context of the click if available
  let semanticContext = '';
  if (eventData.target && eventData.type === 'click' && eventData.target.isInteractive) {
    try {
      const element = document.querySelector(eventData.target.xpath) as HTMLElement;
      if (element) {
        semanticContext = getSemanticContext(element);
      }
    } catch (error) {
      console.error('Error getting semantic context:', error);
    }
  }

  // Detect changes - if waiting for timeout and forced, capture immediate changes
  const changes = forceDomSnapshot ? detectDomChanges(currentDomState) : ['Waiting for DOM changes...'];

  // Create natural language description of the page state with enhanced semantics
  let pageState = `On page titled "${currentDomState.title}"`;

  // Add semantic context about page contents
  if (currentDomState.headings.length > 0) {
    // Just use the first heading to keep it concise
    pageState += ` with heading "${currentDomState.headings[0]}"`;
  }

  // Add context about active modals
  if (currentDomState.modals.length > 0) {
    pageState += `. Active modal: "${currentDomState.modals[0]}"`;
  }

  // Add context about active forms if this was an interaction with a form
  if (
    eventData.target &&
    (eventData.target.tagName === 'input' ||
      eventData.target.tagName === 'select' ||
      eventData.target.tagName === 'textarea' ||
      eventData.target.tagName === 'button')
  ) {
    const formState = currentDomState.formStates.find(f => {
      try {
        const element = document.querySelector(eventData.target.xpath) as HTMLElement;
        return element && element.closest('form');
      } catch {
        return false;
      }
    });

    if (formState && formState.context) {
      pageState += `. Interacting with "${formState.context}"`;
    }
  }

  // Create element info from DOM snapshot if available
  let elementInfo: WorkflowStep['elementInfo'] | undefined = undefined;
  if (lastDomSnapshotData) {
    console.log('Using DOM snapshot data for element info:', lastDomSnapshotData);
    elementInfo = {
      tagName: lastDomSnapshotData.semanticInfo.tagName,
      id: lastDomSnapshotData.semanticInfo.id,
      className: lastDomSnapshotData.semanticInfo.className,
      ariaLabel: lastDomSnapshotData.semanticInfo.ariaLabel,
      labelText: lastDomSnapshotData.semanticInfo.labelText,
      nearbyText: lastDomSnapshotData.nearbyText,
      innerText: lastDomSnapshotData.innerText,
    };

    // Clear the snapshot data to avoid reusing it
    lastDomSnapshotData = null;
  } else {
    console.log('No DOM snapshot data available for this step');
    // Create basic element info from the event data as fallback
    if (eventData.target) {
      elementInfo = {
        tagName: eventData.target.tagName,
        id: eventData.target.id,
        className: eventData.target.className,
        ariaLabel: '',
        labelText: '',
        nearbyText: '',
        innerText: eventData.target.text,
      };
      console.log('Created fallback element info from event data:', elementInfo);
    }
  }

  // Build the workflow step object
  const step: WorkflowStep = {
    action,
    pageState,
    changes,
    timestamp: eventData.timestamp,
    url: eventData.url,
    semanticContext: semanticContext || undefined,
    elementInfo,
    eventData,
  };

  // Merge with previous scroll step if applicable
  const lastStep = workflowHistory[workflowHistory.length - 1];
  if (lastStep && lastStep.action.startsWith('Scrolled') && step.action.startsWith('Scrolled')) {
    console.log('Merging consecutive scroll steps');
    // Replace the last step with the new aggregated info
    lastStep.action = step.action;
    lastStep.pageState = step.pageState;
    lastStep.changes = step.changes;
    lastStep.timestamp = step.timestamp;
    lastStep.url = step.url;
    lastStep.elementInfo = step.elementInfo;
    lastStep.eventData = step.eventData;
    lastStep.semanticContext = step.semanticContext;
  } else {
    workflowHistory.push(step);
  }

  console.log('Workflow history length:', workflowHistory.length);
  console.log('Step details:', {
    action: step.action,
    hasElementInfo: !!step.elementInfo,
    elementInfo: step.elementInfo,
    semanticContext: step.semanticContext,
  });

  // Update previous DOM state for next comparison
  if (forceDomSnapshot) {
    previousDomState = currentDomState;
  }

  // Persist workflow
  try {
    localStorage.setItem('nanobrowser_workflow', JSON.stringify(workflowHistory));
  } catch (error) {
    console.error('Failed to store workflow in localStorage', error);
    chrome.runtime.sendMessage({
      action: 'storeWorkflow',
      data: { workflow: workflowHistory },
    });
  }
}

/**
 * Update the previous workflow step with actual changes
 */
function updateWorkflowStepWithChanges() {
  // If there's no previous step, nothing to update
  if (workflowHistory.length === 0) return;

  // Get the current DOM state
  const currentDomState = captureDomState();

  // Cancel any pending timeout
  if (domChangeTimeoutId !== null) {
    window.clearTimeout(domChangeTimeoutId);
    domChangeTimeoutId = null;
  }

  // Detect actual changes
  const changes = detectDomChanges(currentDomState);

  // Update the last workflow step with actual changes
  const lastStep = workflowHistory[workflowHistory.length - 1];
  lastStep.changes = changes;

  // Update previous DOM state for next comparison
  previousDomState = currentDomState;

  // Mark that we're no longer waiting for changes
  waitingForDomChanges = false;

  console.log('Updated workflow step with actual changes:', changes);

  // Save updated workflow
  try {
    localStorage.setItem('nanobrowser_workflow', JSON.stringify(workflowHistory));
  } catch (error) {
    console.error('Failed to update workflow in localStorage:', error);
  }

  // Notify background script of the update
  chrome.runtime.sendMessage({
    action: 'storeWorkflow',
    data: { workflow: workflowHistory },
  });

  // Also notify that workflow was updated (for real-time updates in the UI)
  chrome.runtime.sendMessage({
    action: 'workflowUpdated',
    data: { timestamp: Date.now() },
  });
}

/**
 * Schedule DOM change detection after a click
 */
function scheduleDomChangeDetection() {
  // Cancel any existing timeout
  if (domChangeTimeoutId !== null) {
    window.clearTimeout(domChangeTimeoutId);
    updateWorkflowStepWithChanges(); // Update with current changes before setting new timeout
  }

  // Set flag that we're waiting for changes
  waitingForDomChanges = true;

  // Schedule change detection after timeout
  domChangeTimeoutId = window.setTimeout(() => {
    console.log('DOM change timeout reached, capturing changes');
    updateWorkflowStepWithChanges();
    domChangeTimeoutId = null;
  }, DOM_CHANGE_TIMEOUT);

  console.log('Scheduled DOM change detection in', DOM_CHANGE_TIMEOUT / 1000, 'seconds');
}

/**
 * Add event to queue and send it to background if it's a click
 */
function handleEvent(event: Event): void {
  console.log('Event received:', event.type);

  const eventData = processEvent(event);
  if (!eventData) {
    console.log('Event data is null, skipping event');
    return;
  }

  // Add to queue
  eventQueue.push(eventData);
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    eventQueue.shift(); // Remove oldest event when queue is full
  }

  // For click events on interactive elements, handle DOM change detection
  if (event.type === 'click' && eventData.target.isInteractive) {
    // If we have a pending change detection, complete it first
    if (waitingForDomChanges) {
      console.log('Detected new click while waiting for DOM changes, capturing current changes');
      updateWorkflowStepWithChanges();
    }

    // Send click event to background for DOM snapshot BEFORE recording the step
    console.log('Sending click event to background script for DOM snapshot');

    // Create a unique identifier for this event
    const eventId = Date.now().toString() + Math.random().toString().substring(2, 8);

    // Store this event in a pending map
    pendingClickEvents.set(eventId, {
      action: eventToNaturalLanguage(eventData),
      eventData: eventData,
    });

    chrome.runtime.sendMessage(
      {
        action: 'captureDOMSnapshot',
        data: {
          eventType: 'click',
          x: (event as MouseEvent).clientX,
          y: (event as MouseEvent).clientY,
          url: window.location.href,
          timestamp: Date.now(),
          isInteractive: true,
          eventId: eventId, // Pass the event ID to correlate with the snapshot response
        },
      },
      response => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error('Error sending message to background:', error);

          // If there was an error, record the step without waiting for the snapshot
          const pendingEvent = pendingClickEvents.get(eventId);
          if (pendingEvent) {
            recordWorkflowStep(pendingEvent.action, pendingEvent.eventData);
            pendingClickEvents.delete(eventId);
          }
        } else {
          console.log('DOM snapshot request sent successfully, response:', response);
          // The workflow step will be recorded when the snapshot data is received
        }
      },
    );

    // Schedule DOM change detection (still do this immediately)
    scheduleDomChangeDetection();
  }
  // For other important events (input, change), record directly
  else if (['input', 'change'].includes(event.type)) {
    const action = eventToNaturalLanguage(eventData);
    recordWorkflowStep(action, eventData, true); // Capture DOM state immediately

    // In every important event, send workflow to background
    chrome.runtime.sendMessage({
      action: 'storeWorkflow',
      data: { workflow: workflowHistory },
    });
  }
  // For scroll events, update scroll tracking instead of recording each event
  else if (event.type === 'scroll') {
    // If already tracking a scroll, just update the tracking
    if (scrollState.isScrolling) {
      updateScrollTracking();
      return;
    }

    // Check if this is a significant scroll that we should start tracking
    if (shouldRecordScrollEvent(event as Event)) {
      // If shouldRecordScrollEvent returns true, we're already tracking
      // A record will be created when the scroll finishes (debounce)
    }
  } else if (event.type === 'keydown') {
    // Only record significant key presses (Enter, Escape, Arrow keys, etc.)
    const keyEvent = event as KeyboardEvent;
    if (isSignificantKeyPress(keyEvent)) {
      // Enhance the event data with key information
      eventData.value = keyEvent.key;
      const action = getEnhancedKeyEventDescription(keyEvent);

      // Create a unique identifier for this event
      const eventId = Date.now().toString() + Math.random().toString().substring(2, 8);

      // Store this event in the pending map
      pendingClickEvents.set(eventId, {
        action: action,
        eventData: eventData,
      });

      // Request DOM snapshot for important key events
      chrome.runtime.sendMessage(
        {
          action: 'captureDOMSnapshot',
          data: {
            eventType: 'keydown',
            key: keyEvent.key,
            url: window.location.href,
            timestamp: Date.now(),
            eventId: eventId,
          },
        },
        response => {
          const error = chrome.runtime.lastError;
          if (error) {
            console.error('Error sending keydown snapshot request:', error);
            // Record without waiting for snapshot
            recordWorkflowStep(action, eventData, true);
            pendingClickEvents.delete(eventId);
          } else {
            console.log('Keydown snapshot request sent successfully');
          }
        },
      );
    }
  }
}

/**
 * Determine if a scroll event is significant enough to record
 */
function shouldRecordScrollEvent(event: Event): boolean {
  // If we're already tracking a scroll, always return false
  // (We'll record once at the end of the scroll via debounce)
  if (scrollState.isScrolling) {
    return false;
  }

  // Get current scroll position
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;
  const docHeight = document.documentElement.scrollHeight;
  const viewportHeight = window.innerHeight;

  // Check if this is a significant scroll that we should record
  // Start tracking the scroll without pre-determining direction
  // We'll determine actual direction in updateScrollTracking

  // Start tracking if we're at the very top (already at top)
  if (scrollY < 10) {
    // Don't set direction yet - wait to see if user scrolls down
    startTrackingScroll('');
    return false;
  }

  // Start tracking if we're at the very bottom (already at bottom)
  if (scrollY + viewportHeight >= docHeight - 20) {
    // Don't set direction yet - wait to see if user scrolls up
    startTrackingScroll('');
    return false;
  }

  // 3. Starting a significant scroll
  // This will start scroll tracking, but won't immediately record
  if (!scrollState.isScrolling && Math.abs(scrollY - scrollState.lastRecordedScrollY) > viewportHeight * 0.2) {
    startTrackingScroll('');
    return false; // Don't record immediately, wait for debounce
  }

  return false;
}

/**
 * Start tracking a new scroll action
 */
function startTrackingScroll(direction: string) {
  // Cancel any existing debounce timer
  if (scrollState.scrollDebounceTimeout !== null) {
    window.clearTimeout(scrollState.scrollDebounceTimeout);
  }

  // 捕获初始Markdown快照
  scrollState.previousMarkdownSnapshot = captureMarkdownSnapshot();
  console.log('Initial Markdown snapshot captured for scroll tracking');

  // Update scroll state
  scrollState.isScrolling = true;
  scrollState.scrollStartY = window.scrollY;
  scrollState.scrollStartX = window.scrollX;
  scrollState.scrollDirection = direction;
  scrollState.scrollStartTime = Date.now();
  scrollState.markdownDifferences = []; // 确保清空之前的差异结果

  // Set debounce timeout to record the scroll after it ends
  scrollState.scrollDebounceTimeout = window.setTimeout(() => {
    finishScrollAction();
  }, 1000); // Wait 1 second after last scroll event
}

/**
 * Update ongoing scroll tracking
 */
function updateScrollTracking() {
  // Reset the debounce timer whenever a new scroll event arrives
  if (scrollState.scrollDebounceTimeout !== null) {
    window.clearTimeout(scrollState.scrollDebounceTimeout);
  }

  if (!scrollState.isScrolling) {
    return;
  }

  // Calculate scroll distance and direction
  const currentScrollY = window.scrollY;
  const currentScrollX = window.scrollX;
  const docHeight = document.documentElement.scrollHeight;
  const viewportHeight = window.innerHeight;

  // Update scroll distance (absolute value)
  scrollState.scrollDistance = Math.abs(currentScrollY - scrollState.scrollStartY);

  // Determine the actual scroll direction based on movement
  if (scrollState.scrollDirection === '') {
    if (currentScrollY > scrollState.scrollStartY) {
      scrollState.scrollDirection = 'down';
    } else if (currentScrollY < scrollState.scrollStartY) {
      scrollState.scrollDirection = 'up';
    } else if (currentScrollX > scrollState.scrollStartX) {
      scrollState.scrollDirection = 'right';
    } else if (currentScrollX < scrollState.scrollStartX) {
      scrollState.scrollDirection = 'left';
    }
  }

  // Special cases for reaching top or bottom of page
  if (currentScrollY < 10) {
    scrollState.scrollDirection = 'reached top';
  } else if (currentScrollY + viewportHeight >= docHeight - 20) {
    scrollState.scrollDirection = 'reached bottom';
  }

  // Periodically analyze what's becoming visible during scroll
  if (scrollState.scrollDistance > viewportHeight * 0.2) {
    // 进行Markdown对比分析（如果有初始快照）
    if (scrollState.previousMarkdownSnapshot) {
      // 捕获当前Markdown进行实时比较
      const currentMarkdown = captureMarkdownSnapshot();
      const differences = compareMarkdownContent(currentMarkdown, scrollState.previousMarkdownSnapshot);

      // 保存有意义的差异
      if (differences.length > 0) {
        scrollState.markdownDifferences = differences;
        console.log('实时滚动变化检测到的Markdown差异:', differences);
      }
    }

    // 常规的元素分析
    analyzeVisibleContentAfterScroll();
  }

  // Set new timeout
  scrollState.scrollDebounceTimeout = window.setTimeout(() => {
    finishScrollAction();
  }, 1000); // Wait 1 second after last scroll event
}

/**
 * Complete a scroll action and record it
 */
function finishScrollAction() {
  // If we're not tracking a scroll, don't do anything
  if (!scrollState.isScrolling) {
    return;
  }

  // 捕获当前的Markdown内容快照
  const currentMarkdown = captureMarkdownSnapshot();

  // 如果我们有上一个Markdown快照，进行比较
  if (scrollState.previousMarkdownSnapshot) {
    const markdownDiffs = compareMarkdownContent(currentMarkdown, scrollState.previousMarkdownSnapshot);

    // 将差异添加到工作流步骤中
    if (markdownDiffs.length > 0) {
      scrollState.markdownDifferences = markdownDiffs;
    }
  }

  // 存储当前快照以供下次使用
  scrollState.previousMarkdownSnapshot = currentMarkdown;

  // Calculate final scroll information
  const endY = window.scrollY;
  const duration = (Date.now() - scrollState.scrollStartTime) / 1000; // seconds
  const distance = Math.abs(endY - scrollState.scrollStartY);
  const direction =
    scrollState.scrollDirection ||
    (endY > scrollState.scrollStartY ? 'down' : endY < scrollState.scrollStartY ? 'up' : '');

  // Prepare readable scroll description
  let scrollAction = '';
  let scrollContext = '';

  // Format based on actual scroll direction (not position)
  if (direction === 'down') {
    scrollAction = 'Scrolled down the page';
  } else if (direction === 'up') {
    scrollAction = 'Scrolled up the page';
  } else if (direction === 'reached top') {
    scrollAction = 'Scrolled to the top of the page';
  } else if (direction === 'reached bottom') {
    scrollAction = 'Scrolled to the bottom of the page';
  } else if (direction === 'right') {
    scrollAction = 'Scrolled right';
  } else if (direction === 'left') {
    scrollAction = 'Scrolled left';
  } else {
    scrollAction = 'Scrolled the page';
  }

  // 如果我们从Markdown比较中找到了变化
  if (scrollState.markdownDifferences && scrollState.markdownDifferences.length > 0) {
    // 最多显示两个最重要的差异
    const importantDiffs = scrollState.markdownDifferences.slice(0, 2);
    scrollAction += ` revealing ${importantDiffs.join(' and ')}`;
  }
  // Analyze what became visible (if we have data from analysis)
  else if (scrollState.newlyVisibleElements) {
    const { interactive, headings } = scrollState.newlyVisibleElements;

    // Prioritize section headings for context
    if (headings.length > 0) {
      const headingTexts = headings.map(h => `"${h.text}"`).filter(text => text.length > 2);
      if (headingTexts.length > 0) {
        scrollAction += ` revealing sections: ${headingTexts.join(', ')}`;
      }
    }

    // Add info about interactive elements that were revealed
    if (interactive.length > 0) {
      // Store this for the event data
      const interactiveTexts = interactive
        .filter(i => i.text.length > 0)
        .map(i => `"${i.text}"`)
        .slice(0, 3);

      if (interactiveTexts.length > 0) {
        scrollContext = `Revealed interactive elements: ${interactiveTexts.join(', ')}`;
        if (interactive.length > interactiveTexts.length) {
          scrollContext += ` and ${interactive.length - interactiveTexts.length} more`;
        }
      }
    }
  }

  // Create event data
  const eventData: EventData = {
    type: 'scroll',
    target: {
      tagName: 'window',
      id: '',
      className: '',
      text: '',
      xpath: '',
      isInteractive: false,
      role: 'scrollable',
      semanticType: 'scroll',
    },
    timestamp: Date.now(),
    url: window.location.href,
    scrollInfo: {
      startY: scrollState.scrollStartY,
      endY,
      direction,
      distance,
      duration,
    },
  };

  // Record the workflow step
  recordWorkflowStep(scrollAction, eventData);

  // If we have context about what became visible, update the last workflow step
  if (scrollContext) {
    const lastStepIndex = workflowHistory.length - 1;
    if (lastStepIndex >= 0) {
      workflowHistory[lastStepIndex].semanticContext = scrollContext;
    }
  }
  // 如果我们有Markdown变化，但没有设置语义上下文
  else if (scrollState.markdownDifferences && scrollState.markdownDifferences.length > 0) {
    const lastStepIndex = workflowHistory.length - 1;
    if (lastStepIndex >= 0) {
      const remainingDiffs = scrollState.markdownDifferences.slice(2); // 除了前两个已经添加到动作描述中的
      if (remainingDiffs.length > 0) {
        workflowHistory[lastStepIndex].semanticContext = `Also revealed: ${remainingDiffs.join(', ')}`;
      }
    }
  }

  // Reset scroll state
  scrollState.isScrolling = false;
  scrollState.scrollDirection = '';
  scrollState.scrollDistance = 0;
  scrollState.scrollDebounceTimeout = null;
  scrollState.lastRecordedScrollY = window.scrollY;
  scrollState.newlyVisibleElements = {
    interactive: [],
    headings: [],
  };
  scrollState.markdownDifferences = []; // 重置Markdown差异
}

/**
 * Check if a key press is significant enough to record
 */
function isSignificantKeyPress(event: KeyboardEvent): boolean {
  // Ignore modifier keys when pressed alone
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
    return false;
  }

  // Record important navigation/action keys
  if (
    [
      'Enter',
      'Escape',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'PageUp',
      'PageDown',
      'Home',
      'End',
      'Backspace',
      'Delete',
    ].includes(event.key)
  ) {
    return true;
  }

  // Record keyboard shortcuts
  if ((event.ctrlKey || event.metaKey) && event.key.length === 1) {
    return true;
  }

  // Don't record most individual character keypresses (too noisy)
  return false;
}

/**
 * Get a more descriptive natural language description for key presses
 */
function getEnhancedKeyEventDescription(event: KeyboardEvent): string {
  const key = event.key;
  const modifiers = [];

  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Meta');

  const modifierText = modifiers.length > 0 ? modifiers.join('+') + '+' : '';

  // Special key descriptions
  switch (key) {
    case 'Enter':
      return `Pressed ${modifierText}Enter key to confirm/submit`;
    case 'Escape':
      return `Pressed Escape key to cancel/close`;
    case 'Tab':
      return `Tabbed to next element`;
    case 'ArrowUp':
      return `Navigated up using arrow key`;
    case 'ArrowDown':
      return `Navigated down using arrow key`;
    case 'ArrowLeft':
      return `Navigated left using arrow key`;
    case 'ArrowRight':
      return `Navigated right using arrow key`;
    case 'PageUp':
      return `Scrolled up one page`;
    case 'PageDown':
      return `Scrolled down one page`;
    case 'Home':
      return `Navigated to start using Home key`;
    case 'End':
      return `Navigated to end using End key`;
    case 'Backspace':
      return `Deleted text using Backspace`;
    case 'Delete':
      return `Deleted text using Delete key`;
    default:
      if (modifiers.length > 0) {
        return `Used keyboard shortcut ${modifierText}${key}`;
      }
      return `Pressed ${key} key`;
  }
}

/**
 * Upload queued events to background script
 */
function uploadEvents(): void {
  if (eventQueue.length === 0) return;

  chrome.runtime.sendMessage({
    action: 'batchUploadEvents',
    data: {
      events: [...eventQueue],
      url: window.location.href,
    },
  });

  // Clear queue after sending
  eventQueue = [];
}

/**
 * Initialize workflow recording by checking if there's existing data
 */
function initWorkflowRecording(): void {
  // Get current tab ID
  chrome.runtime.sendMessage({ action: 'getCurrentTabId' }, response => {
    if (response && response.tabId) {
      currentTabId = response.tabId;
      console.log('Current tab ID:', currentTabId);
    }
  });

  // Try to load existing workflow from localStorage
  try {
    const storedWorkflow = localStorage.getItem('nanobrowser_workflow');
    if (storedWorkflow) {
      const parsed = JSON.parse(storedWorkflow);
      // Validate that it's an array before using it
      if (Array.isArray(parsed)) {
        workflowHistory.push(...parsed);
        console.log(`Loaded ${parsed.length} workflow steps from localStorage`);
      }
    }
  } catch (error) {
    console.error('Failed to load workflow from localStorage', error);

    // Request workflow from background script
    chrome.runtime.sendMessage({ action: 'getWorkflow' }, response => {
      if (response && response.workflow && Array.isArray(response.workflow)) {
        workflowHistory.push(...response.workflow);
        console.log(`Loaded ${response.workflow.length} workflow steps from background`);
      }
    });
  }

  // Initialize DOM state
  previousDomState = captureDomState();

  // Record initial page load
  recordWorkflowStep(
    'Opened page',
    {
      type: 'pageload',
      target: {
        tagName: 'body',
        id: '',
        className: '',
        text: document.title,
        xpath: '/html/body',
        isInteractive: false,
        role: '',
        semanticType: 'page',
      },
      timestamp: Date.now(),
      url: window.location.href,
    },
    true,
  );
}

/**
 * Get the current workflow as an array of natural language strings
 */
function getWorkflowSummary(): string[] {
  return workflowHistory.map(step => {
    const time = new Date(step.timestamp).toLocaleTimeString();

    // Special handling for different action types
    let actionDescription = step.action;
    let stateDescription = step.pageState;
    let changesDescription = '';

    // Handle scroll actions differently - focus more on content revealed
    if (step.action.startsWith('Scrolled')) {
      // For scroll actions, focus on what became visible
      const meaningfulChanges = step.changes.filter(
        change =>
          // Filter for changes that indicate new content or elements
          change.includes('section') ||
          change.includes('New sections') ||
          change.includes('New interactive') ||
          change.includes('revealed') ||
          change.includes('image'),
      );

      if (meaningfulChanges.length > 0) {
        // Use only the most important changes (max 2)
        changesDescription = `\n   Result: ${meaningfulChanges.slice(0, 2).join(', ')}`;
      } else if (step.changes.length > 0) {
        // Fall back to the first change if no meaningful ones found
        changesDescription = `\n   Result: ${step.changes[0]}`;
      }
    } else {
      // For non-scroll actions, use existing changes logic but limit to most important
      if (step.changes.length > 0) {
        // Filter to prioritize the most informative changes
        const priorityChanges = step.changes.filter(
          change =>
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

    // Add semantic context if available - this includes what was revealed by scrolling
    const context = step.semanticContext ? `\n   Context: ${step.semanticContext}` : '';

    // For scroll actions, add scroll-specific information but simplified
    let scrollDetails = '';
    if (step.action.startsWith('Scrolled') && step.eventData?.scrollInfo) {
      const scrollInfo = step.eventData.scrollInfo;
      scrollDetails = `\n   Scroll: ${scrollInfo.direction} direction, ${Math.round(scrollInfo.distance)} pixels`;

      // Only include duration if it's significant
      if (scrollInfo.duration > 1.5) {
        scrollDetails += ` (${scrollInfo.duration.toFixed(1)}s)`;
      }
    }

    return `${time} - ${actionDescription}\n   ${stateDescription}${context}${changesDescription}${scrollDetails}`;
  });
}

/**
 * Export the workflow as a formatted string
 */
function exportWorkflow(): string {
  const summary = getWorkflowSummary();

  if (summary.length === 0) {
    return 'No workflow data available.';
  }

  // Add a title and timestamp
  const title = 'User Workflow Recording';
  const timestamp = new Date().toLocaleString();
  const url = window.location.href;

  // Create a header with metadata
  const header = [
    `${title}`,
    `Recorded on: ${timestamp}`,
    `Starting URL: ${url}`,
    `Total actions: ${summary.length}`,
    '\n',
  ].join('\n');

  return header + summary.join('\n\n');
}

/**
 * Initialize event listeners
 */
function initEventListeners(): void {
  try {
    console.log('Initializing event listeners...');

    // Initialize workflow recording
    initWorkflowRecording();

    // Listen for key user interaction events
    document.addEventListener('click', handleEvent, true);
    document.addEventListener('input', handleEvent, true);
    document.addEventListener('change', handleEvent, true);
    document.addEventListener('scroll', handleEvent, true);
    document.addEventListener('keydown', handleEvent, true);

    // Also listen for navigation events
    window.addEventListener('hashchange', handleEvent);
    window.addEventListener('popstate', handleEvent);

    // Set up batch upload interval
    setInterval(uploadEvents, BATCH_UPLOAD_INTERVAL);

    // Add listener for DOM snapshot data from background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'domSnapshotData') {
        console.log('Received DOM snapshot data from background:', message.data);

        // Store the DOM snapshot data
        lastDomSnapshotData = {
          semanticInfo: message.data.semanticInfo,
          nearbyText: message.data.nearbyText,
          innerText: message.data.innerText,
        };

        // If there's an eventId, this is a response to a specific click event
        if (message.data.eventId) {
          const pendingEvent = pendingClickEvents.get(message.data.eventId);
          if (pendingEvent) {
            console.log('Recording workflow step with DOM snapshot data for event:', message.data.eventId);
            // Now record the workflow step with the DOM snapshot data
            recordWorkflowStep(pendingEvent.action, pendingEvent.eventData);
            // Remove from pending events
            pendingClickEvents.delete(message.data.eventId);
          } else {
            console.log('No pending event found for eventId:', message.data.eventId);
          }
        }

        sendResponse({ success: true });
        return true;
      } else if (message.action === 'getWorkflowSummary') {
        sendResponse({ workflow: exportWorkflow() });
        return true;
      } else if (message.action === 'refreshWorkflow') {
        // Force update the current workflow step with any changes
        if (waitingForDomChanges) {
          updateWorkflowStepWithChanges();
        }
        sendResponse({ success: true });
        return true;
      }
    });

    console.log('Event listeners successfully initialized');
    logger.info('Event listeners initialized');
  } catch (error) {
    console.error('Failed to initialize event listeners:', error);
    logger.error('Failed to initialize event listeners:', error);
  }
}

// Start listening for events when content script loads
initEventListeners();

// Let background script know content script has loaded
console.log('Sending contentScriptLoaded message to background');
chrome.runtime.sendMessage(
  {
    action: 'contentScriptLoaded',
    data: {
      url: window.location.href,
      timestamp: Date.now(),
    },
  },
  response => {
    // Add this callback function to check if the message was sent successfully
    const error = chrome.runtime.lastError;
    if (error) {
      console.error('Error sending contentScriptLoaded message:', error);
    } else {
      console.log('contentScriptLoaded message sent successfully');
    }
  },
);

// Store pending click events waiting for DOM snapshot data
const pendingClickEvents = new Map<
  string,
  {
    action: string;
    eventData: EventData;
  }
>();

/**
 * Analyze what content has become visible after scrolling
 */
function analyzeVisibleContentAfterScroll(): void {
  // Get the elements that are now visible in the viewport after scrolling
  const viewportHeight = window.innerHeight;
  const visibleElements = Array.from(document.querySelectorAll('*')).filter(el => {
    const rect = el.getBoundingClientRect();
    // Element is now visible in the viewport (fully or partially)
    return (
      (rect.top >= 0 && rect.top <= viewportHeight) ||
      (rect.bottom >= 0 && rect.bottom <= viewportHeight) ||
      (rect.top <= 0 && rect.bottom >= viewportHeight)
    );
  });

  // Look for significant newly visible elements
  const interactiveElements = visibleElements.filter(
    el =>
      isInteractiveElement(el as HTMLElement) &&
      el.getBoundingClientRect().height > 10 &&
      el.getBoundingClientRect().width > 10,
  );

  // Look for heading elements that became visible
  const headings = visibleElements.filter(
    el =>
      /^h[1-6]$/i.test(el.tagName) ||
      ((el as HTMLElement).style.fontWeight === 'bold' && (el as HTMLElement).innerText.length > 10),
  );

  // Store this information for use in finishScrollAction
  scrollState.newlyVisibleElements = {
    interactive: interactiveElements
      .map(el => ({
        element: el as HTMLElement,
        text: (el as HTMLElement).innerText?.trim().substring(0, 50) || '',
        type: getSemanticType(el as HTMLElement),
      }))
      .slice(0, 5), // Limit to 5 most relevant
    headings: headings
      .map(el => ({
        element: el as HTMLElement,
        text: (el as HTMLElement).innerText?.trim().substring(0, 100) || '',
      }))
      .slice(0, 3), // Limit to 3 most relevant headings
  };
}

/**
 * Compare Markdown content between states and return significant differences
 */
function compareMarkdownContent(current: string, previous: string): string[] {
  console.log('Previous Markdown content:', previous);
  console.log('Current Markdown content:', current);

  // Split content into lines for comparison
  const previousLines = previous.split('\n').filter(line => line.trim().length > 0);
  const currentLines = current.split('\n').filter(line => line.trim().length > 0);

  // Find lines that are in current but not in previous (newly visible content)
  const newLines = currentLines.filter(line => !previousLines.includes(line));

  // Only include reasonably meaningful lines (not just generic div or spans)
  const meaningfulLines = newLines.filter(line => {
    // Skip very short lines
    if (line.length < 10) return false;

    // Skip generic elements
    if (line.startsWith('div:') || line.startsWith('span:')) return false;

    // Prioritize heading and interactive elements
    const isHeading = line.match(/^h[1-6]:/i);
    const isInteractive = line.includes('button') || line.includes('link') || line.includes('card');
    const isImage = line.startsWith('img:');

    return isHeading || isInteractive || isImage || line.includes('section') || line.length > 30;
  });

  // Create natural language descriptions for the differences
  const differences: string[] = [];
  const maxDifferences = 3; // Limit to 3 meaningful differences

  // Group by type to provide better summary
  const headings = meaningfulLines.filter(line => line.match(/^h[1-6]:/i));
  const interactiveElements = meaningfulLines.filter(
    line => line.includes('button') || line.includes('link') || line.includes('checkbox'),
  );
  const images = meaningfulLines.filter(line => line.startsWith('img:'));
  const otherElements = meaningfulLines.filter(
    line => !headings.includes(line) && !interactiveElements.includes(line) && !images.includes(line),
  );

  // Summarize headings
  if (headings.length > 0) {
    const headingTexts = headings
      .map(heading => {
        const match = heading.match(/: "([^"]*)"/);
        return match ? match[1] : heading;
      })
      .slice(0, 2);

    differences.push(
      `New sections revealed: ${headingTexts.join(', ')}${headings.length > 2 ? ` and ${headings.length - 2} more` : ''}`,
    );
  }

  // Summarize interactive elements
  if (interactiveElements.length > 0) {
    const elementTexts = interactiveElements
      .map(element => {
        const match = element.match(/: "([^"]*)"/);
        return match ? match[1] : element;
      })
      .slice(0, 2);

    differences.push(
      `New interactive elements: ${elementTexts.join(', ')}${interactiveElements.length > 2 ? ` and ${interactiveElements.length - 2} more` : ''}`,
    );
  }

  // Summarize images
  if (images.length > 0) {
    differences.push(`${images.length} new image${images.length > 1 ? 's' : ''} revealed`);
  }

  // Summarize other elements if we have space
  if (otherElements.length > 0 && differences.length < maxDifferences) {
    differences.push(`${otherElements.length} other content element${otherElements.length > 1 ? 's' : ''} revealed`);
  }

  // If no specific differences were found but there are new lines, provide a generic message
  if (differences.length === 0 && newLines.length > 0) {
    differences.push(`${newLines.length} new content element${newLines.length > 1 ? 's' : ''} revealed`);
  }

  return differences;
}

/**
 * 捕获页面内容的Markdown表示
 */
function captureMarkdownSnapshot(): string {
  // 获取所有可见元素
  const visibleElements: string[] = [];
  const visibleHeadings: string[] = [];
  const interactiveElements: string[] = [];
  const images: string[] = [];

  // 获取可视区域尺寸
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  // 标题元素
  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
    const rect = heading.getBoundingClientRect();
    // 检查元素是否在视口内
    if (rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0) {
      const tag = heading.tagName.toLowerCase();
      const text = heading.textContent?.trim() || '';
      if (text) {
        visibleHeadings.push(`${tag}: "${text}"`);
      }
    }
  });

  // 交互元素
  document.querySelectorAll('button, a, [role="button"], [role="link"]').forEach(element => {
    if (!(element instanceof HTMLElement)) return;

    const rect = element.getBoundingClientRect();
    if (rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0) {
      const tag = element.tagName.toLowerCase();
      const text = element.textContent?.trim() || '';
      const role = element.getAttribute('role') || '';

      if (text) {
        interactiveElements.push(`${tag}${role ? `[${role}]` : ''}: "${text}"`);
      }
    }
  });

  // 图片
  document.querySelectorAll('img').forEach(img => {
    const rect = img.getBoundingClientRect();
    if (rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0) {
      const alt = img.alt || '';
      const src = img.src.split('/').pop() || '';
      images.push(`img: "${alt || src}"`);
    }
  });

  // 其他重要的可见元素
  document.querySelectorAll('p, li, section, article, div.card, div.product').forEach(element => {
    if (!(element instanceof HTMLElement)) return;

    const rect = element.getBoundingClientRect();
    // 检查元素是否可见且有合理大小
    if (
      rect.top < viewportHeight &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.right > 0 &&
      rect.height > 20 &&
      rect.width > 50
    ) {
      // 过滤掉太小的元素

      const tag = element.tagName.toLowerCase();
      const text = element.textContent?.trim().substring(0, 100) || '';

      // 只添加有意义的文本内容（忽略空的或者太短的）
      if (text && text.length > 20) {
        visibleElements.push(`${tag}: "${text}${text.length >= 100 ? '...' : ''}"`);
      }
    }
  });

  // 构建Markdown内容
  const markdown = [...visibleHeadings, ...interactiveElements, ...images, ...visibleElements].join('\n');

  console.log('Generated Markdown snapshot:', markdown);
  return markdown;
}
