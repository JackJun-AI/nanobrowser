import { DOMElementNode } from '../views';
import { compareDOMTrees, formatDOMDiffResult, trackDOMChanges } from './dom-diff';
import BrowserContext from '../../browser/context';

/**
 * 创建测试用DOM树
 */
function createTestDOMTree(isModified = false): DOMElementNode {
  // 创建根元素
  const root = new DOMElementNode({
    tagName: 'html',
    xpath: '/html',
    attributes: {},
    children: [],
    isVisible: true,
  });

  // 创建body元素
  const body = new DOMElementNode({
    tagName: 'body',
    xpath: '/html/body',
    attributes: { class: 'main-body' },
    children: [],
    isVisible: true,
    parent: root,
  });
  root.children.push(body);

  // 创建div容器
  const container = new DOMElementNode({
    tagName: 'div',
    xpath: '/html/body/div',
    attributes: {
      id: 'container',
      class: isModified ? 'container modified' : 'container',
    },
    children: [],
    isVisible: true,
    parent: body,
  });
  body.children.push(container);

  // 添加几个子元素
  for (let i = 1; i <= 3; i++) {
    const child = new DOMElementNode({
      tagName: 'div',
      xpath: `/html/body/div/div[${i}]`,
      attributes: {
        id: `item-${i}`,
        class: 'item',
      },
      children: [],
      isVisible: true,
      parent: container,
    });
    container.children.push(child);

    // 在修改版本中修改第二个元素的属性
    if (isModified && i === 2) {
      child.attributes['data-modified'] = 'true';
      child.attributes['style'] = 'color: red;';
    }
  }

  // 在修改版本中添加一个新元素
  if (isModified) {
    const newElement = new DOMElementNode({
      tagName: 'span',
      xpath: '/html/body/div/span',
      attributes: {
        id: 'new-element',
        class: 'highlight',
      },
      children: [],
      isVisible: true,
      parent: container,
    });
    container.children.push(newElement);
  }

  return root;
}

/**
 * 测试两个DOM树之间的差异
 */
async function testDOMTreeDiff() {
  console.log('===== DOM树差异对比测试 =====');

  // 创建原始DOM树和修改后的DOM树
  const originalTree = createTestDOMTree(false);
  const modifiedTree = createTestDOMTree(true);

  console.log('原始DOM树结构:', originalTree);
  console.log('修改后DOM树结构:', modifiedTree);

  // 比较两棵树
  console.log('计算DOM树差异...');
  const diffResult = await compareDOMTrees(originalTree, modifiedTree);

  // 格式化并输出结果
  const formattedResult = formatDOMDiffResult(diffResult);
  console.log(formattedResult);

  return diffResult;
}

/**
 * 从当前活动标签页获取DOM树
 */
async function getCurrentDOMTree(): Promise<DOMElementNode | null> {
  try {
    // 创建浏览器上下文
    const browserContext = new BrowserContext({});

    // 获取当前页面
    const page = await browserContext.getCurrentPage();
    if (!page) {
      console.error('无法获取当前页面');
      return null;
    }

    // 获取当前页面的DOM树
    const state = await page.getState();
    return state.elementTree;
  } catch (error) {
    console.error('获取DOM树失败:', error);
    return null;
  }
}

/**
 * 跟踪实时DOM变化
 */
export async function trackRealTimeDOMChanges(delayMs = 10000): Promise<void> {
  console.log(`===== 实时DOM变化跟踪 =====`);
  console.log(`将记录当前DOM树，${delayMs / 1000}秒后比较变化...`);

  // 获取初始DOM树
  const initialTree = await getCurrentDOMTree();
  if (!initialTree) {
    console.error('获取初始DOM树失败');
    return;
  }

  console.log('初始DOM树已记录，请在页面上进行一些操作...');

  // 跟踪变化
  const diffResult = await trackDOMChanges(initialTree, delayMs, getCurrentDOMTree);

  // 格式化并输出结果
  const formattedResult = formatDOMDiffResult(diffResult);
  console.log(formattedResult);
}

// 运行测试
console.log('开始DOM树差异测试...');
testDOMTreeDiff()
  .then(() => console.log('测试完成'))
  .catch(error => console.error('测试过程中出错:', error));

// 导出实时DOM变化跟踪函数，以便从控制台调用
// 使用globalThis代替window，以兼容Service Worker环境
(globalThis as any).trackRealTimeDOMChanges = trackRealTimeDOMChanges;
