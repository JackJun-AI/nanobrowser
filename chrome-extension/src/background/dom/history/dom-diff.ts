import { DOMElementNode, DOMBaseNode, DOMTextNode } from '../views';
import { compareHistoryElementAndDomElement, convertDomElementToHistoryElement } from './service';
import { DOMHistoryElement } from './view';

export interface DOMDiffResult {
  added: DOMElementNode[];
  removed: DOMElementNode[];
  modified: Array<{
    oldElement: DOMElementNode;
    newElement: DOMElementNode;
    changes: string[];
  }>;
  unchanged: DOMElementNode[];
}

/**
 * 比较两个DOM树并返回差异
 * @param oldTree 旧的DOM树
 * @param newTree 新的DOM树
 * @returns 包含添加、删除、修改和未变化元素的结果对象
 */
export async function compareDOMTrees(oldTree: DOMElementNode, newTree: DOMElementNode): Promise<DOMDiffResult> {
  const result: DOMDiffResult = {
    added: [],
    removed: [],
    modified: [],
    unchanged: [],
  };

  // 用于跟踪已处理的元素
  const processedOldElements = new Set<DOMElementNode>();
  const processedNewElements = new Set<DOMElementNode>();

  // 递归比较两棵树
  await compareNodes(oldTree, newTree, result, processedOldElements, processedNewElements);

  // 找出被删除的元素（在旧树中但不在新树中）
  await findRemovedElements(oldTree, processedOldElements, result);

  // 找出新增的元素（在新树中但不在旧树中）
  await findAddedElements(newTree, processedNewElements, result);

  return result;
}

/**
 * 递归比较两个节点及其子节点
 */
async function compareNodes(
  oldNode: DOMElementNode,
  newNode: DOMElementNode,
  result: DOMDiffResult,
  processedOldElements: Set<DOMElementNode>,
  processedNewElements: Set<DOMElementNode>,
): Promise<void> {
  // 将两个节点标记为已处理
  processedOldElements.add(oldNode);
  processedNewElements.add(newNode);

  // 比较当前节点
  const oldHistoryElement = convertDomElementToHistoryElement(oldNode);
  const identical = await compareHistoryElementAndDomElement(oldHistoryElement, newNode);

  if (identical) {
    // 节点本身相同，但需要检查其子节点
    result.unchanged.push(oldNode);

    // 比较子节点
    await compareChildNodes(oldNode, newNode, result, processedOldElements, processedNewElements);
  } else {
    // 节点发生变化
    const changes = await detectElementChanges(oldNode, newNode);
    result.modified.push({
      oldElement: oldNode,
      newElement: newNode,
      changes,
    });

    // 尽管节点不同，我们仍然比较它们的子节点
    await compareChildNodes(oldNode, newNode, result, processedOldElements, processedNewElements);
  }
}

/**
 * 比较两个元素的子节点
 */
async function compareChildNodes(
  oldParent: DOMElementNode,
  newParent: DOMElementNode,
  result: DOMDiffResult,
  processedOldElements: Set<DOMElementNode>,
  processedNewElements: Set<DOMElementNode>,
): Promise<void> {
  const oldElementChildren = oldParent.children.filter(child => child instanceof DOMElementNode) as DOMElementNode[];

  const newElementChildren = newParent.children.filter(child => child instanceof DOMElementNode) as DOMElementNode[];

  // 使用启发式算法尝试匹配子元素
  for (const oldChild of oldElementChildren) {
    if (processedOldElements.has(oldChild)) continue;

    let bestMatch: DOMElementNode | null = null;
    let highestScore = 0;

    for (const newChild of newElementChildren) {
      if (processedNewElements.has(newChild)) continue;

      const score = await calculateSimilarityScore(oldChild, newChild);
      if (score > highestScore) {
        highestScore = score;
        bestMatch = newChild;
      }
    }

    // 如果找到了合理的匹配（相似度大于阈值）
    if (bestMatch && highestScore > 0.7) {
      await compareNodes(oldChild, bestMatch, result, processedOldElements, processedNewElements);
    }
  }
}

/**
 * 查找被删除的元素
 */
async function findRemovedElements(
  node: DOMElementNode,
  processedElements: Set<DOMElementNode>,
  result: DOMDiffResult,
): Promise<void> {
  if (!processedElements.has(node)) {
    result.removed.push(node);
    processedElements.add(node);
  }

  // 递归检查子元素
  for (const child of node.children) {
    if (child instanceof DOMElementNode) {
      await findRemovedElements(child, processedElements, result);
    }
  }
}

/**
 * 查找新增的元素
 */
async function findAddedElements(
  node: DOMElementNode,
  processedElements: Set<DOMElementNode>,
  result: DOMDiffResult,
): Promise<void> {
  if (!processedElements.has(node)) {
    result.added.push(node);
    processedElements.add(node);
  }

  // 递归检查子元素
  for (const child of node.children) {
    if (child instanceof DOMElementNode) {
      await findAddedElements(child, processedElements, result);
    }
  }
}

/**
 * 计算两个DOM元素的相似度得分
 * 返回0-1之间的值，1表示完全相同
 */
async function calculateSimilarityScore(elem1: DOMElementNode, elem2: DOMElementNode): Promise<number> {
  let score = 0;
  let totalWeight = 0;

  // 比较标签名（权重：3）
  if (elem1.tagName === elem2.tagName) {
    score += 3;
  }
  totalWeight += 3;

  // 比较XPath（权重：2）
  if (elem1.xpath === elem2.xpath) {
    score += 2;
  }
  totalWeight += 2;

  // 比较ID属性（权重：4）
  if (elem1.attributes.id && elem2.attributes.id && elem1.attributes.id === elem2.attributes.id) {
    score += 4;
  }
  totalWeight += 4;

  // 比较class属性（权重：2）
  if (elem1.attributes.class && elem2.attributes.class) {
    const class1Set = new Set(elem1.attributes.class.split(/\s+/));
    const class2Set = new Set(elem2.attributes.class.split(/\s+/));
    let commonClasses = 0;

    // 使用Array.from将Set转换为数组再循环，避免TS问题
    Array.from(class1Set).forEach(cls => {
      if (class2Set.has(cls)) {
        commonClasses++;
      }
    });

    const maxClasses = Math.max(class1Set.size, class2Set.size);
    if (maxClasses > 0) {
      score += 2 * (commonClasses / maxClasses);
    }
  }
  totalWeight += 2;

  // 返回归一化得分（0-1之间）
  return score / totalWeight;
}

/**
 * 检测元素发生了哪些变化
 */
async function detectElementChanges(oldElem: DOMElementNode, newElem: DOMElementNode): Promise<string[]> {
  const changes: string[] = [];

  // 检查标签变化
  if (oldElem.tagName !== newElem.tagName) {
    changes.push(`标签从 ${oldElem.tagName} 变为 ${newElem.tagName}`);
  }

  // 检查属性变化
  const oldAttrs = oldElem.attributes;
  const newAttrs = newElem.attributes;

  // 检查被移除或修改的属性
  for (const [key, value] of Object.entries(oldAttrs)) {
    if (!(key in newAttrs)) {
      changes.push(`属性 ${key}="${value}" 被移除`);
    } else if (newAttrs[key] !== value) {
      changes.push(`属性 ${key} 从 "${value}" 变为 "${newAttrs[key]}"`);
    }
  }

  // 检查新增的属性
  for (const [key, value] of Object.entries(newAttrs)) {
    if (!(key in oldAttrs)) {
      changes.push(`新增属性 ${key}="${value}"`);
    }
  }

  // 检查可见性变化
  if (oldElem.isVisible !== newElem.isVisible) {
    changes.push(`可见性从 ${oldElem.isVisible} 变为 ${newElem.isVisible}`);
  }

  // 检查交互性变化
  if (oldElem.isInteractive !== newElem.isInteractive) {
    changes.push(`交互性从 ${oldElem.isInteractive} 变为 ${newElem.isInteractive}`);
  }

  // 检查位置变化
  if (oldElem.viewportCoordinates && newElem.viewportCoordinates) {
    const oldCenter = oldElem.viewportCoordinates.center;
    const newCenter = newElem.viewportCoordinates.center;

    if (oldCenter.x !== newCenter.x || oldCenter.y !== newCenter.y) {
      changes.push(`位置从 (${oldCenter.x}, ${oldCenter.y}) 变为 (${newCenter.x}, ${newCenter.y})`);
    }
  }

  return changes;
}

/**
 * 记录当前DOM树并在指定时间后比较变化
 * @param initialTree 初始DOM树
 * @param delayMs 延迟时间（毫秒）
 * @param getCurrentTree 获取当前DOM树的函数
 * @returns Promise，解析为DOM差异结果
 */
export async function trackDOMChanges(
  initialTree: DOMElementNode,
  delayMs: number,
  getCurrentTree: () => Promise<DOMElementNode>,
): Promise<DOMDiffResult> {
  // 记录初始DOM树
  console.log(`记录初始DOM树，将在 ${delayMs}ms 后比较变化...`);

  // 等待指定时间
  await new Promise(resolve => setTimeout(resolve, delayMs));

  // 获取当前DOM树
  const currentTree = await getCurrentTree();

  // 比较两个树并返回差异
  console.log('对比DOM树变化...');
  return compareDOMTrees(initialTree, currentTree);
}

/**
 * 格式化DOM树差异结果为易读字符串
 */
export function formatDOMDiffResult(result: DOMDiffResult): string {
  const lines: string[] = [];

  lines.push(`===== DOM树变化分析 =====`);
  lines.push(`新增元素: ${result.added.length}个`);
  lines.push(`删除元素: ${result.removed.length}个`);
  lines.push(`修改元素: ${result.modified.length}个`);
  lines.push(`未变元素: ${result.unchanged.length}个`);

  if (result.added.length > 0) {
    lines.push('\n----- 新增元素 -----');
    result.added.forEach((elem, i) => {
      lines.push(`${i + 1}. <${elem.tagName}> ${elem.xpath ? `(${elem.xpath})` : ''}`);
    });
  }

  if (result.removed.length > 0) {
    lines.push('\n----- 删除元素 -----');
    result.removed.forEach((elem, i) => {
      lines.push(`${i + 1}. <${elem.tagName}> ${elem.xpath ? `(${elem.xpath})` : ''}`);
    });
  }

  if (result.modified.length > 0) {
    lines.push('\n----- 修改元素 -----');
    result.modified.forEach((mod, i) => {
      lines.push(`${i + 1}. <${mod.oldElement.tagName}> ${mod.oldElement.xpath ? `(${mod.oldElement.xpath})` : ''}`);
      mod.changes.forEach(change => {
        lines.push(`   - ${change}`);
      });
    });
  }

  return lines.join('\n');
}
