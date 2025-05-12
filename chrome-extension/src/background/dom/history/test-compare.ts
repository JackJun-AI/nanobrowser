import { DOMElementNode } from '../views';
import { DOMHistoryElement } from './view';
import { compareHistoryElementAndDomElement, convertDomElementToHistoryElement } from './service';

// 创建测试用的DOM元素
function createTestDomElement(
  tagName: string,
  attributes: Record<string, string> = {},
  xpath: string = '',
): DOMElementNode {
  const element = new DOMElementNode({
    tagName: tagName,
    xpath: xpath,
    attributes: attributes,
    children: [],
    isVisible: true,
    highlightIndex: 1,
  });

  // 模拟getEnhancedCssSelector方法
  element.getEnhancedCssSelector = () => `${tagName}[test]`;

  return element;
}

// 测试用例1：比较相同的元素
async function testIdenticalElements() {
  console.log('=== 测试相同元素 ===');

  // 创建DOM元素
  const domElement = createTestDomElement('div', { id: 'test', class: 'container' }, '/html/body/div');

  // 转换为历史元素
  const historyElement = convertDomElementToHistoryElement(domElement);

  // 比较并打印结果
  const result = await compareHistoryElementAndDomElement(historyElement, domElement);

  console.log('DOM元素:', domElement);
  console.log('历史元素:', historyElement);
  console.log('比较结果:', result);
  console.log('预期结果: true');
}

// 测试用例2：比较不同的元素
async function testDifferentElements() {
  console.log('=== 测试不同元素 ===');

  // 创建两个不同的DOM元素
  const domElement1 = createTestDomElement('div', { id: 'test1' }, '/html/body/div[1]');
  const domElement2 = createTestDomElement('div', { id: 'test2' }, '/html/body/div[2]');

  // 转换第一个为历史元素
  const historyElement = convertDomElementToHistoryElement(domElement1);

  // 比较并打印结果
  const result = await compareHistoryElementAndDomElement(historyElement, domElement2);

  console.log('DOM元素1:', domElement1);
  console.log('DOM元素2:', domElement2);
  console.log('历史元素 (基于DOM元素1):', historyElement);
  console.log('比较结果:', result);
  console.log('预期结果: false');
}

// 主测试函数
async function runTests() {
  console.log('开始测试 compareHistoryElementAndDomElement 函数...');

  await testIdenticalElements();
  console.log('\n');
  await testDifferentElements();

  console.log('\n测试完成!');
}

// 执行测试
runTests().catch(error => {
  console.error('测试过程中出错:', error);
});
