export const $ = id => document.getElementById(id);
export const text = (id, value) => { $(id).textContent = value ?? ''; };
/** 创建元素：props 写属性（className、dataset 等），children 为节点或文本。 */
export function el(tag, props = {}, ...children) {
 const node = Object.assign(document.createElement(tag), props);
 node.append(...children.filter(child => child !== null && child !== undefined));
 return node;
}
/** 用户在底部附近时才跟随新内容，离开底部后不打断阅读。 */
export function nearBottom(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < 48; }
