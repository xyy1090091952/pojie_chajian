/**
 * 数据层：消息存储（环形缓冲）
 * ------------------------------------------------------------
 * 职责（单一）：在后台（service worker）里保存抓到的所有网络消息，
 *   并对外提供"加入一条 / 取全部 / 清空"的接口。
 *
 * 为什么要环形缓冲：
 *   抓包会源源不断产生数据，如果无限存会撑爆内存。
 *   所以设定上限 MAX_MESSAGES，超了就把最老的那条丢掉（先进先出）。
 *
 * 为什么单独成模块：
 *   把"数据怎么存"和"数据从哪来/给谁用"分开，
 *   以后要换成 IndexedDB 落盘，也只改这一个文件。
 */

import { CONFIG } from '../common/constants.js';
import { parseCards } from './card-parser.js';

// 用模块内变量保存状态，保证整个后台只有这一份数据（单一数据源）
let records = [];
let autoId = 0; // 自增 id，给每条消息一个唯一编号

/**
 * 加入一条原始抓包数据，内部会顺便把牌解析好一起存起来。
 * @param {object} raw content 脚本传来的原始记录
 *   { direction, transport, url, payload, timestamp }
 * @returns {object} 存好的完整记录（含 id 和解析出的 cards）
 */
export function addRecord(raw) {
  // 尝试把 payload 解析成对象，方便界面展开查看；失败就保留原始字符串
  let parsed = raw.payload;
  if (typeof raw.payload === 'string') {
    try {
      parsed = JSON.parse(raw.payload);
    } catch {
      parsed = raw.payload; // 不是 JSON 就原样保留
    }
  }

  const record = {
    id: ++autoId,
    direction: raw.direction,
    transport: raw.transport,
    url: raw.url || '',
    timestamp: raw.timestamp || Date.now(),
    payload: parsed, // 结构化后的内容
    cards: parseCards(raw.payload), // 从中识别到的牌（数据层直接算好）
  };

  records.push(record);

  // 超出上限就丢最老的（环形缓冲核心）
  if (records.length > CONFIG.MAX_MESSAGES) {
    records.shift();
  }

  return record;
}

/** 取出当前全部记录（给 panel 打开时做一次性快照用） */
export function getAll() {
  return records;
}

/** 清空所有记录 */
export function clear() {
  records = [];
  autoId = 0;
}
