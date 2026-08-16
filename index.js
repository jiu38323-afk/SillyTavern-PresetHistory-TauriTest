/**
 * SillyTavern-PresetHistory TauriTest v2.2.3
 *
 * 预设版本历史扩展 —— 自动 + 手动备份预设，一键回退
 * 拦截设置/预设保存请求，提取预设数据，按名字保存快照。
 *
 * by Elvis & 小九
 */

import { extension_settings } from '../../../extensions.js';
import * as OpenAI from '../../../openai.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

// 测试版使用独立设置空间，不会读写正式版的历史快照。
const EXT_NAME = 'preset-history-tauri-test';
const PRESET_SAVE_ENDPOINTS = ['/api/settings/save', '/api/presets/save'];

const DEFAULTS = {
    enabled: true,
    autoSnapshot: true,
    autoSavePreset: true,
    lockParams: false,    // 锁定参数（温度、top_p等）
    lockPrompts: false,   // 锁定条目（内容、顺序、开关）
    maxSnapshotsPerPreset: 30,
    snapshots: {},
};

// ========== Settings ==========

function getSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    var s = extension_settings[EXT_NAME];
    for (var key in DEFAULTS) {
        if (s[key] === undefined) {
            var val = DEFAULTS[key];
            s[key] = (typeof val === 'object' && val !== null) ? JSON.parse(JSON.stringify(val)) : val;
        }
    }
    return s;
}

// ========== 工具 ==========

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fmtTime(ts) {
    var d = new Date(ts);
    function pad(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return h.toString(16);
}

function escapeHTML(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function deepClone(obj) {
    try { return structuredClone(obj); }
    catch (e) { return JSON.parse(JSON.stringify(obj)); }
}

function stableStringify(value) {
    function normalize(input) {
        if (Array.isArray(input)) {
            return input.map(normalize);
        }
        if (input && typeof input === 'object') {
            var sorted = {};
            var keys = Object.keys(input).sort();
            for (var i = 0; i < keys.length; i++) {
                if (input[keys[i]] !== undefined) sorted[keys[i]] = normalize(input[keys[i]]);
            }
            return sorted;
        }
        return input;
    }
    return JSON.stringify(normalize(value));
}

function getPresetHash(data) {
    try {
        var normalized = deepClone(data || {});
        // 预设名不属于预设内容，切换或改名时不应产生伪差异。
        if (normalized && typeof normalized === 'object') delete normalized.preset_settings_openai;
        return hash(stableStringify(normalized));
    } catch (e) {
        return '';
    }
}

function getCurrentPresetSelect() {
    // 正确拼写优先；旧插件把历史拼写 settings_perset 放在前面，
    // TauriTavern 同时保留多个节点时会读到隐藏的旧值。
    var presetSelectors = ['#settings_preset_openai', '#settings_perset_openai', 'select[name="preset_openai"]'];
    var $fallback = null;
    for (var i = 0; i < presetSelectors.length; i++) {
        var $matches = jQuery(presetSelectors[i]);
        if (!$matches.length) continue;
        var $visible = $matches.filter(':visible').first();
        if ($visible.length) return $visible;
        if (!$fallback) $fallback = $matches.first();
    }
    return $fallback || jQuery();
}

function getCurrentPresetName() {
    // 内存状态是当前真正生效的预设，优先于可能隐藏或滞后的 DOM 下拉框。
    if (OpenAI.oai_settings && typeof OpenAI.oai_settings.preset_settings_openai === 'string') {
        var settingsName = OpenAI.oai_settings.preset_settings_openai.trim();
        if (settingsName) return settingsName;
    }

    var $ps = getCurrentPresetSelect();
    if ($ps.length) {
        var selectedText = $ps.find('option:selected').text().trim();
        if (selectedText) return selectedText;
    }
    return '';
}

// ========== 从请求体里提取预设 ==========

// 缓存最后一次拦截到的完整请求体（给手动备份用）
var lastInterceptedBody = null;

/**
 * 直接从酒馆当前的 Chat Completion 设置构建预设。
 * TauriTavern 的原生网络层不一定经过扩展改写后的 window.fetch，
 * 所以直接读取是主路径，请求拦截只作为旧版兼容兜底。
 */
function buildPresetData(settings) {
    var sourceSettings = settings || OpenAI.oai_settings;
    if (!sourceSettings) return null;

    if (typeof OpenAI.getChatCompletionPreset === 'function') {
        return OpenAI.getChatCompletionPreset(sourceSettings);
    }

    if (OpenAI.settingsToUpdate) {
        var presetData = {};
        var entries = Object.entries(OpenAI.settingsToUpdate);
        for (var i = 0; i < entries.length; i++) {
            var presetKey = entries[i][0];
            var settingsKey = entries[i][1][1];
            presetData[presetKey] = sourceSettings[settingsKey];
        }
        return deepClone(presetData);
    }

    return null;
}

function getLivePresetInfo() {
    try {
        var presetData = buildPresetData(OpenAI.oai_settings);

        if (!presetData || typeof presetData !== 'object' || Object.keys(presetData).length === 0) return null;

        return {
            name: getCurrentPresetName() || '当前预设',
            data: presetData,
        };
    } catch (e) {
        console.warn('[PresetHistory] 读取当前预设失败:', e);
        return null;
    }
}

function rememberPresetInfo(info) {
    if (!info) return;
    lastInterceptedBody = {
        apiId: 'openai',
        name: info.name,
        preset: deepClone(info.data),
    };
}

function getBestCurrentPresetInfo() {
    var liveInfo = getLivePresetInfo();
    if (liveInfo) {
        rememberPresetInfo(liveInfo);
        return liveInfo;
    }
    return lastInterceptedBody ? extractPresetInfo(lastInterceptedBody) : null;
}

/**
 * 从 settings save 的请求体里找到预设名和预设数据。
 * ST 保存 settings 时会把所有东西一起发过去，
 * 我们只关心聊天补全(Chat Completion)相关的部分。
 *
 * 会尝试多个可能的字段名来兼容不同版本。
 */
function extractPresetInfo(body) {
    if (!body || typeof body !== 'object') return null;

    // SillyTavern 1.18+ / TauriTavern 使用统一预设接口：
    // { apiId: 'openai', name: '预设名', preset: { ...预设内容 } }
    // 旧版只读取顶层字段，因此能拦到请求却无法识别其中的预设。
    if (body.preset && typeof body.preset === 'object' && !Array.isArray(body.preset)) {
        // 本扩展只管理聊天补全预设，忽略文本补全/高级格式等其他预设。
        if (body.apiId && body.apiId !== 'openai') return null;

        var wrappedName = typeof body.name === 'string' ? body.name.trim() : '';
        return {
            name: wrappedName || getCurrentPresetName() || '当前预设',
            data: body.preset,
        };
    }

    // ---- 尝试找预设名 ----
    var nameFields = [
        'preset_settings_openai',   // 一些版本用这个
        'openai_setting',           // 另一些版本
    ];
    var presetName = null;
    for (var i = 0; i < nameFields.length; i++) {
        if (body[nameFields[i]] && typeof body[nameFields[i]] === 'string') {
            presetName = body[nameFields[i]];
            break;
        }
    }

    // ---- 尝试找预设数据 ----
    // 方案A：body里有独立的 oai_settings / openai_settings 对象
    var dataFields = ['oai_settings', 'openai_settings'];
    var presetData = null;
    for (var j = 0; j < dataFields.length; j++) {
        if (body[dataFields[j]] && typeof body[dataFields[j]] === 'object' && Object.keys(body[dataFields[j]]).length > 0) {
            presetData = body[dataFields[j]];
            break;
        }
    }

    // 方案B：如果没有独立的对象，说明预设字段直接铺在 body 顶层
    // 用特征字段检测是不是预设数据，确认后保存全部字段
    if (!presetData) {
        var checkFields = ['temp_openai', 'top_p_openai', 'freq_pen_openai',
            'openai_max_context', 'stream_openai', 'prompts', 'prompt_order'];
        var found = 0;
        for (var k = 0; k < checkFields.length; k++) {
            if (body[checkFields[k]] !== undefined) found++;
        }
        // 至少找到5个特征字段 → 确认是预设数据 → 保存body全部字段
        if (found >= 5) {
            presetData = body;
        }
    }

    // 如果还是没有，也试试 prompt_manager_settings, prompts, prompt_order
    // 因为这些是预设的核心（条目列表和顺序）
    if (!presetData && body.prompts && body.prompt_order) {
        presetData = {
            prompts: body.prompts,
            prompt_order: body.prompt_order,
        };
        if (body.prompt_manager_settings) presetData.prompt_manager_settings = body.prompt_manager_settings;
    }

    if (!presetData) return null;

    // 如果没从请求体找到名字，从页面上的预设下拉菜单读
    if (!presetName) {
        presetName = getCurrentPresetName();
    }

    if (!presetName) presetName = '当前预设';

    return { name: presetName, data: presetData };
}

// ========== 快照核心 ==========

function saveSnapshot(presetName, data, source, customLabel) {
    // 新版预设字段会持续增加，完整计算内容哈希，避免白名单漏掉 temperature 等字段。
    // 键名排序后再序列化，防止对象键顺序不同造成假变化。
    var h = getPresetHash(data);
    if (!h) return null;

    var settings = getSettings();
    var key = presetName;
    var existing = settings.snapshots[key] || [];

    if (source === 'auto') {
        if (existing.length === 0) {
            // 没备份过 → 存第一份作为基线
            console.log('[PresetHistory] 首次备份: ' + presetName);
        } else if (existing[0].hash === h || getPresetHash(existing[0].data) === h) {
            // 有备份，内容一样 → 跳过
            return null;
        } else if (restoredToHash && restoredToHash === h) {
            // 刚恢复到这个版本，跳过（不重复存恢复后的状态）
            console.log('[PresetHistory] 恢复后的保存，跳过');
            restoredToHash = '';
            return null;
        } else {
            // 有备份，内容不同 → 存新版本
            console.log('[PresetHistory] 内容变化，备份: ' + presetName);
        }
    }

    var snap = {
        id: newId(),
        ts: Date.now(),
        label: customLabel || (source === 'auto' ? '自动备份' : '手动备份'),
        hash: h,
        starred: false,
        data: deepClone(data),
    };

    // 裁剪：只删没收藏的，收藏的不占名额
    var newList = [snap].concat(existing);
    var unstarredCount = 0;
    var trimmed = [];
    for (var ti = 0; ti < newList.length; ti++) {
        if (newList[ti].starred) {
            trimmed.push(newList[ti]); // 收藏的永远保留
        } else {
            unstarredCount++;
            if (unstarredCount <= settings.maxSnapshotsPerPreset) {
                trimmed.push(newList[ti]);
            }
            // 超出上限的非收藏版本直接丢弃
        }
    }
    settings.snapshots[key] = trimmed;
    saveSettingsDebounced();
    return snap;
}

function getSnapshots(presetName) {
    return getSettings().snapshots[presetName] || [];
}

function deleteSnap(presetName, id) {
    var s = getSettings();
    if (!s.snapshots[presetName]) return;
    s.snapshots[presetName] = s.snapshots[presetName].filter(function (x) { return x.id !== id; });
    if (s.snapshots[presetName].length === 0) delete s.snapshots[presetName];
    saveSettingsDebounced();
}

function toggleStar(presetName, id) {
    var s = getSettings();
    var snaps = s.snapshots[presetName];
    if (!snaps) return;
    for (var i = 0; i < snaps.length; i++) {
        if (snaps[i].id === id) {
            if (!snaps[i].starred) {
                // 检查收藏上限
                var starredCount = snaps.filter(function (x) { return x.starred; }).length;
                if (starredCount >= 10) {
                    toastr.warning('每个预设最多收藏10个版本。');
                    return;
                }
            }
            snaps[i].starred = !snaps[i].starred;
            break;
        }
    }
    saveSettingsDebounced();
}

function getAllPresetNames() {
    var s = getSettings();
    var names = [];
    for (var k in s.snapshots) {
        if (s.snapshots[k].length > 0) names.push({ name: k, count: s.snapshots[k].length });
    }
    return names;
}

// ========== Fetch 拦截器 ==========

var fetchPatched = false;
var originalFetch = null;
var isRestoring = false;
var restoredToHash = ''; // 刚恢复到的版本的hash，用于跳过恢复后的重复备份
var directCaptureInstalled = false;
var presetSwitchCaptureInstalled = false;

function isPresetSaveRequest(url, method) {
    if (method !== 'POST') return false;
    for (var i = 0; i < PRESET_SAVE_ENDPOINTS.length; i++) {
        if (url.indexOf(PRESET_SAVE_ENDPOINTS[i]) !== -1) return true;
    }
    return false;
}

async function readJsonRequestBody(input, init) {
    var body = init && init.body;

    if (typeof body === 'string') {
        return JSON.parse(body);
    }

    // 兼容以 Blob 等对象传入的 JSON 请求体。
    if (body && typeof body.text === 'function') {
        var bodyText = await body.text();
        return bodyText ? JSON.parse(bodyText) : null;
    }

    // 兼容 fetch(new Request(...))；clone 避免消费真正发送的请求体。
    if ((body === undefined || body === null) && input && typeof input.clone === 'function') {
        var requestClone = input.clone();
        if (typeof requestClone.text === 'function') {
            var requestText = await requestClone.text();
            return requestText ? JSON.parse(requestText) : null;
        }
    }

    return null;
}

function handlePresetInfo(info) {
    if (!info) return;

    // 即使关闭自动备份也缓存最新预设，保证“立即备份”仍然可用。
    rememberPresetInfo(info);

    var settings = getSettings();
    if (!settings.autoSnapshot) return;

    // 自动生成标签：对比上一个备份找出改了什么
    var autoLabel = '';
    var existingSnaps = getSnapshots(info.name);
    if (existingSnaps.length > 0) {
        var diffs = diffPresets(existingSnaps[0].data, info.data, 'changelog');
        var realDiffs = diffs.filter(function (d) { return d !== '没有检测到差异'; });
        autoLabel = realDiffs.length > 0 ? realDiffs.slice(0, 3).join('；') : '自动备份';
    } else {
        autoLabel = '首次备份';
    }

    var snap = saveSnapshot(info.name, info.data, 'auto', autoLabel);
    if (snap) {
        console.log('[PresetHistory] 自动备份: ' + info.name);
        setTimeout(renderSnapshotList, 0);
    }
}

function handlePresetSaveBody(parsed) {
    handlePresetInfo(extractPresetInfo(parsed));
}

async function capturePresetSaveRequest(input, init) {
    try {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (!isPresetSaveRequest(url, method)) return;

        var parsed = await readJsonRequestBody(input, init);
        if (parsed) handlePresetSaveBody(parsed);
    } catch (e) {
        console.warn('[PresetHistory] Parse error:', e);
    }
}

function installFetchInterceptor() {
    if (fetchPatched) return;
    originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') {
        console.warn('[PresetHistory] window.fetch 不可用，无法安装拦截器');
        return;
    }

    window.fetch = function (input, init) {
        if (!isRestoring) {
            // 不阻塞酒馆自己的保存请求；解析失败也不会影响原请求。
            capturePresetSaveRequest(input, init).catch(function (e) {
                console.warn('[PresetHistory] Interceptor error:', e);
            });
        }
        return originalFetch.apply(this, arguments);
    };
    fetchPatched = true;
    console.log('[PresetHistory] 拦截器已安装');
}

function installDirectPresetCapture() {
    if (directCaptureInstalled) return;

    // TauriTavern 可能让请求直接进入原生网络层，因此在“保存当前预设”按钮处
    // 再读取一次酒馆内存中的真实预设。普通 SillyTavern 同样兼容。
    jQuery(document).on('click.presetHistoryCapture', '#update_oai_preset', function () {
        if (isRestoring) return;
        setTimeout(function () {
            var info = getLivePresetInfo();
            if (info) handlePresetInfo(info);
        }, 0);
    });

    directCaptureInstalled = true;
    console.log('[PresetHistory] 当前预设直读捕获已安装');
}

function installPresetSwitchCapture() {
    if (presetSwitchCaptureInstalled || !eventSource || !event_types) return;

    // 切走之前先保存旧预设。此时事件里的 settings 仍是旧预设内容，
    // presetNameBefore 则是它的真实名字，不会发生“新名字 + 旧内容”的串档。
    if (event_types.OAI_PRESET_CHANGED_BEFORE) {
        eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, function (event) {
            if (isRestoring || !event) return;
            var oldName = typeof event.presetNameBefore === 'string' ? event.presetNameBefore.trim() : '';
            var oldData = buildPresetData(event.settings);
            if (oldName && oldData) handlePresetInfo({ name: oldName, data: oldData });
        });
    }

    // 新预设完全应用后再建立它的基线，并把历史列表跟到当前预设。
    if (event_types.PRESET_CHANGED) {
        eventSource.on(event_types.PRESET_CHANGED, function (event) {
            if (isRestoring || !event || event.apiId !== 'openai') return;
            setTimeout(function () {
                var info = getLivePresetInfo();
                if (!info) return;
                if (typeof event.name === 'string' && event.name.trim()) info.name = event.name.trim();
                handlePresetInfo(info);
                jQuery('#ph_filter_name').val('');
                renderSnapshotList();
            }, 0);
        });
    }

    presetSwitchCaptureInstalled = true;
    console.log('[PresetHistory] 预设切换捕获已安装');
}

// ========== 对比 ==========

/**
 * 对比两组预设数据的差异
 * oldData = 旧版本, newData = 新版本
 * mode = 'changelog'(自动标签用) 或 'restore'(恢复确认用)
 */
function diffPresets(oldData, newData, mode) {
    if (!mode) mode = 'restore';
    oldData = oldData || {};
    newData = newData || {};
    var diffs = [];

    var oldPrompts = (oldData && oldData.prompts) || [];
    var newPrompts = (newData && newData.prompts) || [];

    // 条目内容索引 (identifier → prompt对象)
    var oldContentMap = {};
    for (var i = 0; i < oldPrompts.length; i++) {
        oldContentMap[oldPrompts[i].identifier] = oldPrompts[i];
    }
    var newContentMap = {};
    for (var j = 0; j < newPrompts.length; j++) {
        newContentMap[newPrompts[j].identifier] = newPrompts[j];
    }

    // 从 prompt_order 里提取开关状态和顺序
    // prompt_order 结构: [ { character_id, order: [{identifier, enabled}, ...] } ]
    var oldOrder = [];
    var newOrder = [];
    var oldEnabledMap = {};
    var newEnabledMap = {};

    var oldPO = (oldData && oldData.prompt_order) || [];
    var newPO = (newData && newData.prompt_order) || [];
    if (oldPO.length > 0 && oldPO[0] && oldPO[0].order) {
        oldOrder = oldPO[0].order;
        for (var oi = 0; oi < oldOrder.length; oi++) {
            oldEnabledMap[oldOrder[oi].identifier] = !!oldOrder[oi].enabled;
        }
    }
    if (newPO.length > 0 && newPO[0] && newPO[0].order) {
        newOrder = newPO[0].order;
        for (var ni = 0; ni < newOrder.length; ni++) {
            newEnabledMap[newOrder[ni].identifier] = !!newOrder[ni].enabled;
        }
    }

    // 用来查名字的辅助函数
    function getName(id) {
        if (newContentMap[id]) return newContentMap[id].name || '未命名';
        if (oldContentMap[id]) return oldContentMap[id].name || '未命名';
        return '未命名';
    }

    // 新增的条目：区分"创建"和"绑定"
    // prompts里新增但order里没有 = 创建了条目（还没绑定）
    for (var pk in newContentMap) {
        if (!oldContentMap[pk] && !newEnabledMap[pk]) {
            if (mode === 'changelog') {
                diffs.push('创建了条目「' + getName(pk) + '」');
            } else {
                diffs.push('「' + getName(pk) + '」会被创建');
            }
        }
    }

    // order里新增 = 绑定到预设
    for (var nk in newEnabledMap) {
        if (oldEnabledMap[nk] === undefined) {
            var isAlsoNewInPrompts = !oldContentMap[nk];
            if (mode === 'changelog') {
                diffs.push((isAlsoNewInPrompts ? '新增了' : '绑定了') + '「' + getName(nk) + '」');
            } else {
                diffs.push('「' + getName(nk) + '」' + (isAlsoNewInPrompts ? '会被新增' : '会被绑定'));
            }
        }
    }

    // 从order移除（条目还在prompts里，可以绑回来）
    for (var ok in oldEnabledMap) {
        if (newEnabledMap[ok] === undefined) {
            if (newContentMap[ok]) {
                // 还在prompts里 = 只是从预设移除
                if (mode === 'changelog') {
                    diffs.push('从预设移除了「' + getName(ok) + '」');
                } else {
                    diffs.push('恢复后会找回「' + getName(ok) + '」');
                }
            }
            // 不在prompts里的情况交给下面的prompts删除检测处理
        }
    }

    // 从prompts里彻底删除
    for (var dk in oldContentMap) {
        if (!newContentMap[dk]) {
            if (mode === 'changelog') {
                diffs.push('彻底删除了「' + (oldContentMap[dk].name || '未命名') + '」');
            } else {
                diffs.push('「' + (oldContentMap[dk].name || '未命名') + '」会被恢复');
            }
        }
    }

    // 开关变化
    for (var ek in oldEnabledMap) {
        if (newEnabledMap[ek] !== undefined && oldEnabledMap[ek] !== newEnabledMap[ek]) {
            if (mode === 'changelog') {
                diffs.push((newEnabledMap[ek] ? '开启' : '关闭') + '了「' + getName(ek) + '」');
            } else {
                diffs.push('「' + getName(ek) + '」' + (newEnabledMap[ek] ? '会被开启' : '会被关闭'));
            }
        }
    }

    // 内容修改（比较prompts数组里的content和name）
    for (var mk in oldContentMap) {
        if (newContentMap[mk]) {
            var op = oldContentMap[mk];
            var np = newContentMap[mk];
            var changes = [];
            if ((op.content || '') !== (np.content || '')) changes.push('内容');
            if ((op.name || '') !== (np.name || '')) changes.push('名称');
            if (changes.length > 0) {
                if (mode === 'changelog') {
                    diffs.push('修改了「' + (np.name || '未命名') + '」' + changes.join('、'));
                } else {
                    diffs.push('「' + (op.name || '未命名') + '」' + changes.join('、') + '不同');
                }
            }
        }
    }

    // 顺序变化
    var oldIds = oldOrder.map(function (x) { return x.identifier; }).join(',');
    var newIds = newOrder.map(function (x) { return x.identifier; }).join(',');
    if (oldIds !== newIds && oldOrder.length > 0 && newOrder.length > 0) {
        // 排除纯增删导致的顺序差异，只看共有条目的相对顺序
        var commonOld = oldOrder.filter(function (x) { return newEnabledMap[x.identifier] !== undefined; }).map(function (x) { return x.identifier; });
        var commonNew = newOrder.filter(function (x) { return oldEnabledMap[x.identifier] !== undefined; }).map(function (x) { return x.identifier; });
        if (commonOld.join(',') !== commonNew.join(',')) {
            diffs.push('条目顺序变化');
        }
    }

    // 参数变化：同时兼容旧版内部字段名和新版预设导出字段名。
    var settingFields = [
        { keys: ['temperature', 'temp_openai'], label: '温度' },
        { keys: ['top_p', 'top_p_openai'], label: 'Top P' },
        { keys: ['top_k', 'top_k_openai'], label: 'Top K' },
        { keys: ['min_p', 'min_p_openai'], label: 'Min P' },
        { keys: ['top_a', 'top_a_openai'], label: 'Top A' },
        { keys: ['frequency_penalty', 'freq_pen_openai'], label: '频率惩罚' },
        { keys: ['presence_penalty', 'pres_pen_openai'], label: '存在惩罚' },
        { keys: ['repetition_penalty', 'repetition_penalty_openai'], label: '重复惩罚' },
        { keys: ['openai_max_context'], label: '上下文长度' },
        { keys: ['openai_max_tokens'], label: '最大回复长度' },
    ];

    function readSetting(data, keys) {
        for (var ri = 0; ri < keys.length; ri++) {
            if (data[keys[ri]] !== undefined) return data[keys[ri]];
        }
        return undefined;
    }

    var settingChanges = [];
    for (var sf = 0; sf < settingFields.length; sf++) {
        var oldValue = readSetting(oldData, settingFields[sf].keys);
        var newValue = readSetting(newData, settingFields[sf].keys);
        if (oldValue !== undefined && newValue !== undefined && stableStringify(oldValue) !== stableStringify(newValue)) {
            settingChanges.push(settingFields[sf].label);
        }
    }
    if (settingChanges.length > 0) {
        diffs.push('参数变化：' + settingChanges.join('、'));
    }

    // 其余预设字段也参与提示，避免新版增加字段后只备份却说不出改了什么。
    var ignoredKeys = { prompts: true, prompt_order: true, preset_settings_openai: true };
    for (var ig = 0; ig < settingFields.length; ig++) {
        for (var ik = 0; ik < settingFields[ig].keys.length; ik++) ignoredKeys[settingFields[ig].keys[ik]] = true;
    }
    var friendlyNames = {
        stream_openai: '流式输出',
        chat_completion_source: '接口来源',
        openai_model: 'OpenAI 模型',
        claude_model: 'Claude 模型',
        openrouter_model: 'OpenRouter 模型',
        google_model: 'Google 模型',
        custom_model: '自定义模型',
        custom_url: '自定义接口地址',
        names_behavior: '名称行为',
        send_if_empty: '空消息内容',
        impersonation_prompt: '角色扮演提示词',
        new_chat_prompt: '新聊天提示词',
        new_group_chat_prompt: '新群聊提示词',
        continue_nudge_prompt: '继续生成提示词',
        custom_prompt_post_processing: '提示词后处理',
        reasoning_effort: '推理强度',
        verbosity: '详细程度',
        seed: 'Seed',
    };
    var allOtherKeys = {};
    Object.keys(oldData).forEach(function (key) { allOtherKeys[key] = true; });
    Object.keys(newData).forEach(function (key) { allOtherKeys[key] = true; });
    var otherChanges = [];
    Object.keys(allOtherKeys).sort().forEach(function (key) {
        if (ignoredKeys[key]) return;
        if (stableStringify(oldData[key]) !== stableStringify(newData[key])) {
            otherChanges.push(friendlyNames[key] || key.replace(/_/g, ' '));
        }
    });
    if (otherChanges.length > 0) {
        var shownChanges = otherChanges.slice(0, 4);
        var moreText = otherChanges.length > shownChanges.length ? '等' + otherChanges.length + '项' : '';
        diffs.push('设置变化：' + shownChanges.join('、') + moreText);
    }

    if (diffs.length === 0) {
        diffs.push('没有检测到差异');
    }

    return diffs;
}

// ========== 恢复 ==========

// 从 session cookie 里提取 CSRF 令牌
// ST 把 CSRF token 存在 session cookie 里，格式是 base64 编码的 JSON: {"csrfToken":"xxx"}
function getCsrfToken() {
    try {
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
            var c = cookies[i].trim();
            // session cookie 的名字是 session-xxxxxxxx=base64data
            if (c.match(/^session-[a-f0-9]+=/) && !c.includes('.sig')) {
                var val = c.split('=').slice(1).join('=');
                var decoded = atob(val);
                var obj = JSON.parse(decoded);
                if (obj.csrfToken) return obj.csrfToken;
            }
        }
    } catch (e) {
        console.warn('[PresetHistory] Failed to extract CSRF token:', e);
    }
    return '';
}

async function restoreSnapshot(presetName, snap) {
    try {
        // 先备份当前的
        var currentInfo = getBestCurrentPresetInfo();
        if (currentInfo) {
            saveSnapshot(currentInfo.name, currentInfo.data, 'manual', '恢复前备份：' + snap.label);
        }

        var bodyToSend = deepClone(snap.data);

        // 通过ST自带的预设导入功能恢复（绕过CSRF问题）
        // 把快照数据包装成File对象，塞进ST的导入文件输入框
        var jsonStr = JSON.stringify(bodyToSend, null, 2);
        var file = new File([jsonStr], presetName + '.json', { type: 'application/json' });

        var $fileInput = jQuery('#openai_preset_import_file');
        if ($fileInput.length === 0) {
            toastr.error('找不到预设导入入口，请手动导入。');
            return false;
        }

        // 创建一个新的FileList塞进去
        var dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        $fileInput[0].files = dataTransfer.files;

        // 记录恢复目标的hash，恢复后的自动保存如果匹配就跳过
        restoredToHash = getPresetHash(snap.data) || snap.hash || '';

        // 触发change事件，让ST的导入逻辑接管
        $fileInput[0].dispatchEvent(new Event('input', { bubbles: true }));

        toastr.success('正在通过导入恢复「' + presetName + '」...\n请在弹出的对话框中确认。');
        return true;
    } catch (e) {
        toastr.error('恢复失败: ' + e.message);
        return false;
    }
}

// ========== 锁定功能 ==========

var lockStyleAdded = false;

function applyLocks() {
    var s = getSettings();

    // 添加锁定样式（只加一次）
    if (!lockStyleAdded) {
        var style = document.createElement('style');
        style.id = 'ph-lock-styles';
        style.textContent = ''
            + '.ph-locked-params #range_block_openai { pointer-events: none; opacity: 0.5; position: relative; }'
            + '.ph-locked-params #range_block_openai::after { content: "🔒 参数已锁定"; position: absolute; top: 4px; right: 8px; font-size: 12px; opacity: 0.8; }'
            + '.ph-locked-prompts #completion_prompt_manager { pointer-events: none; opacity: 0.5; position: relative; }'
            + '.ph-locked-prompts #completion_prompt_manager::after { content: "🔒 条目已锁定"; position: absolute; top: 4px; right: 8px; font-size: 12px; opacity: 0.8; }'
            + '.ph-locked-prompts .completion_prompt_manager_popup { pointer-events: none; opacity: 0.5; }'
            + '.ph-locked-prompts .prompt-manager-prompt-controls { pointer-events: none; }'
            + '.ph-locked-prompts .prompt_manager_prompt_toggle { pointer-events: none; }'
            + '.ph-locked-prompts .ui-sortable-handle { cursor: default !important; }'
            ;
        document.head.appendChild(style);
        lockStyleAdded = true;
    }

    var $body = jQuery('body');

    if (s.lockParams) {
        $body.addClass('ph-locked-params');
    } else {
        $body.removeClass('ph-locked-params');
    }

    if (s.lockPrompts) {
        $body.addClass('ph-locked-prompts');
    } else {
        $body.removeClass('ph-locked-prompts');
    }
}

// ========== 自动保存预设 ==========

var autoSaveInstalled = false;
var autoSaveTimer = null;

function triggerPresetSave() {
    // 防抖2秒，避免连续操作触发多次保存
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(function () {
        var s = getSettings();
        if (!s.autoSavePreset) return;
        var $btn = jQuery('#update_oai_preset');
        if ($btn.length) {
            // 静默保存：临时屏蔽toastr提示
            var origSuccess = toastr.success;
            toastr.success = function () {};
            $btn.trigger('click');
            setTimeout(function () { toastr.success = origSuccess; }, 500);
            console.log('[PresetHistory] 静默自动保存预设');
        }
    }, 2000);
}

function installAutoSave() {
    if (autoSaveInstalled) return;

    // 1. 条目保存按钮：保存条目后自动保存预设
    jQuery(document).on('click.presetHistory', '#completion_prompt_manager_popup_entry_form_save', triggerPresetSave);

    // 2. 参数滑块/输入框变化：iOS 拖动滑块主要触发 input，不一定触发 change。
    var paramSelectors = [
        '#temp_openai', '#top_p_openai', '#top_k_openai', '#min_p_openai', '#top_a_openai',
        '#freq_pen_openai', '#pres_pen_openai', '#repetition_penalty_openai',
        '#openai_max_context', '#openai_max_tokens', '#seed_openai',
        '#stream_toggle', '#names_behavior', '#reasoning_effort', '#openai_reasoning_effort', '#openai_verbosity'
    ];
    jQuery(document).on('input.presetHistory change.presetHistory', paramSelectors.join(','), function (event, eventData) {
        // 酒馆在加载另一个预设时也会批量触发 input；这些不是用户修改，交给切换监听处理。
        if (eventData && eventData.source === 'preset') return;
        triggerPresetSave();
    });

    // 3. 条目开关变化
    jQuery(document).on('click.presetHistory', '.prompt_manager_prompt_toggle, .prompt-toggle, [data-pm-toggle]', triggerPresetSave);

    // 4. 条目拖拽排序完成
    jQuery(document).on('sortupdate.presetHistory', triggerPresetSave);

    autoSaveInstalled = true;
    console.log('[PresetHistory] 自动保存已安装');
}

// ========== UI ==========

function addUI() {
    var html = '<div id="ph_settings">'
        + '<div class="inline-drawer">'
        + '<div class="inline-drawer-toggle inline-drawer-header">'
        + '<b>🧪 预设历史测试版</b>'
        + '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>'
        + '</div>'
        + '<div class="inline-drawer-content">'

        + '<label class="checkbox_label"><input id="ph_auto_snapshot" type="checkbox" /><span>保存时自动备份</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:8px">每次保存预设或编辑条目时，自动备份一份。</small>'

        + '<label class="checkbox_label"><input id="ph_auto_save_preset" type="checkbox" /><span>操作后自动保存预设</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:8px">编辑条目后自动保存预设到文件，防止切换预设时丢失修改。</small>'

        + '<hr style="margin:8px 0" />'

        + '<label class="checkbox_label"><input id="ph_lock_params" type="checkbox" /><span>🔒 锁定参数</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:4px">锁住温度、Top P、频率惩罚等滑块，防止误触。</small>'

        + '<label class="checkbox_label"><input id="ph_lock_prompts" type="checkbox" /><span>🔒 锁定条目</span></label>'
        + '<small style="display:block;opacity:0.6;margin-bottom:8px">锁住条目的内容编辑、开关和顺序拖拽。</small>'

        + '<div style="margin:6px 0"><label>每个预设最多保留 <input id="ph_max_snapshots" type="number" min="1" max="500" style="width:60px" /> 个版本</label>'
        + '<br/><small style="opacity:0.6">超出后自动删除最老的。</small></div>'

        + '<hr style="margin:8px 0" />'

        + '<div style="margin:6px 0">'
        + '<input id="ph_manual_label" type="text" placeholder="可自定义备注，例如「开防截断，温度1.3」..." style="width:100%;box-sizing:border-box;margin-bottom:6px" />'
        + '<button id="ph_manual_now" class="menu_button" style="font-size:12px;padding:6px 12px;width:100%;white-space:nowrap;writing-mode:horizontal-tb">📸 立即备份当前状态</button>'
        + '</div>'

        + '<hr style="margin:8px 0" />'

        + '<div style="margin:6px 0"><label style="display:block;margin-bottom:4px;font-weight:600">查看备份记录</label>'
        + '<small style="display:block;opacity:0.65;margin-bottom:5px">当前酒馆预设：<b id="ph_current_preset_name">读取中…</b><br/>下面只筛选历史记录，不会切换酒馆预设。</small>'
        + '<select id="ph_filter_name" style="width:100%;box-sizing:border-box"></select></div>'

        + '<div id="ph_snapshot_list" style="max-height:400px;overflow-y:auto;border:1px solid rgba(128,128,128,0.3);border-radius:6px;padding:4px;margin-top:6px">'
        + '<div style="padding:16px;text-align:center;opacity:0.5;font-style:italic">还没有备份。</div></div>'

        + '</div></div></div>';

    var $target = jQuery('#extensions_settings2, #extensions_settings').first();
    if ($target.length) $target.append(html);
    else jQuery('#top-settings-holder').append(html);

    var s = getSettings();
    jQuery('#ph_auto_snapshot').prop('checked', s.autoSnapshot).on('change', function () {
        s.autoSnapshot = this.checked; saveSettingsDebounced();
        if (s.autoSnapshot) installFetchInterceptor();
    });

    // 操作后自动保存预设
    jQuery('#ph_auto_save_preset').prop('checked', s.autoSavePreset).on('change', function () {
        s.autoSavePreset = this.checked; saveSettingsDebounced();
        if (s.autoSavePreset) installAutoSave();
    });
    if (s.autoSavePreset) installAutoSave();

    // 锁定参数
    jQuery('#ph_lock_params').prop('checked', s.lockParams).on('change', function () {
        s.lockParams = this.checked; saveSettingsDebounced();
        applyLocks();
    });

    // 锁定条目
    jQuery('#ph_lock_prompts').prop('checked', s.lockPrompts).on('change', function () {
        s.lockPrompts = this.checked; saveSettingsDebounced();
        applyLocks();
    });

    applyLocks();
    jQuery('#ph_max_snapshots').val(s.maxSnapshotsPerPreset).on('change', function () {
        var v = parseInt(this.value, 10);
        if (!isNaN(v) && v > 0 && v <= 500) {
            s.maxSnapshotsPerPreset = v; saveSettingsDebounced();
            for (var k in s.snapshots) {
                var starred = s.snapshots[k].filter(function (x) { return x.starred; });
                var unstarred = s.snapshots[k].filter(function (x) { return !x.starred; });
                if (unstarred.length > v) unstarred = unstarred.slice(0, v);
                // 重组：保持原始顺序
                var trimmed = [];
                var ui = 0;
                for (var si = 0; si < s.snapshots[k].length; si++) {
                    if (s.snapshots[k][si].starred) {
                        trimmed.push(s.snapshots[k][si]);
                    } else if (ui < unstarred.length) {
                        trimmed.push(unstarred[ui++]);
                    }
                }
                s.snapshots[k] = trimmed;
            }
            renderSnapshotList();
        }
    });
    jQuery('#ph_manual_now').on('click', manualSnapshotNow);
    jQuery('#ph_filter_name').on('change', renderSnapshotList);

    // DOM 变化作为旧版酒馆的 UI 同步兜底；实际快照由预设事件监听负责。
    var $currentPresetSelect = getCurrentPresetSelect();
    if ($currentPresetSelect.length) {
        $currentPresetSelect.on('change.presetHistoryFilter', function () {
            setTimeout(function () {
                jQuery('#ph_filter_name').val('');
                renderSnapshotList();
            }, 50);
        });
    }

    renderSnapshotList();
}

function renderNameFilter() {
    var $sel = jQuery('#ph_filter_name');
    var cur = $sel.val();
    $sel.empty();

    // 从酒馆当前内存状态读取真实生效的预设名；DOM 只用于枚举全部名字。
    var allPresets = [];
    var currentSTPreset = getCurrentPresetName();
    var $stSelect = getCurrentPresetSelect();
    if ($stSelect.length) {
        $stSelect.find('option').each(function () {
            var val = jQuery(this).val();
            var text = jQuery(this).text().trim();
            if (val && text) allPresets.push(text);
        });
    }
    jQuery('#ph_current_preset_name').text(currentSTPreset || '未读取到');

    // 获取有备份的预设
    var backedUp = getAllPresetNames();
    var backupMap = {};
    for (var i = 0; i < backedUp.length; i++) {
        backupMap[backedUp[i].name] = backedUp[i].count;
    }

    // 合并：当前预设排第一，有备份的排前面，没备份的排后面
    var seen = {};
    var options = [];

    // 当前预设排第一
    if (currentSTPreset) {
        var count = backupMap[currentSTPreset] || 0;
        options.push({ name: currentSTPreset, count: count, current: true });
        seen[currentSTPreset] = true;
    }

    // 有备份的排前面
    for (var b = 0; b < backedUp.length; b++) {
        var bName = backedUp[b].name;
        if (!seen[bName]) {
            options.push({ name: bName, count: backedUp[b].count, current: false });
            seen[bName] = true;
        }
    }

    // 没备份的排后面
    for (var a = 0; a < allPresets.length; a++) {
        if (!seen[allPresets[a]]) {
            options.push({ name: allPresets[a], count: 0, current: false });
            seen[allPresets[a]] = true;
        }
    }

    if (options.length === 0) {
        $sel.append('<option value="">(还没有预设)</option>');
        return;
    }

    for (var j = 0; j < options.length; j++) {
        var prefix = options[j].current ? '▶ ' : '';
        var suffix = options[j].count > 0 ? ' — ' + options[j].count + ' 个备份' : ' — 未备份';
        $sel.append(jQuery('<option></option>').val(options[j].name).text(prefix + options[j].name + suffix));
    }

    // 优先选当前ST预设，否则保持用户之前的选择
    if (currentSTPreset && !cur) {
        $sel.val(currentSTPreset);
    } else if (cur && options.find(function (x) { return x.name === cur; })) {
        $sel.val(cur);
    } else if (currentSTPreset) {
        $sel.val(currentSTPreset);
    }
}

function renderSnapshotList() {
    var $list = jQuery('#ph_snapshot_list');
    if ($list.length === 0) return;
    renderNameFilter();

    var name = jQuery('#ph_filter_name').val();
    $list.empty();

    if (!name) {
        $list.html('<div style="padding:16px;text-align:center;opacity:0.5;font-style:italic">还没有备份。保存一次预设后会自动出现。</div>');
        return;
    }

    var snaps = getSnapshots(name);
    if (snaps.length === 0) {
        $list.html('<div style="padding:16px;text-align:center;opacity:0.5;font-style:italic">这个预设还没有备份。</div>');
        return;
    }

    for (var i = 0; i < snaps.length; i++) {
        (function (snap) {
            var starIcon = snap.starred ? '⭐' : '☆';
            var starStyle = snap.starred ? 'background:rgba(255,200,0,0.15);' : '';
            var $item = jQuery(
                '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,0.2);gap:6px;' + starStyle + '">'
                + '<div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">'
                + '<span style="font-weight:600;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (snap.starred ? '⭐ ' : '') + escapeHTML(snap.label) + '</span>'
                + '<span style="font-size:0.75em;opacity:0.6;font-family:monospace">' + fmtTime(snap.ts) + '</span></div>'
                + '<div style="display:flex;gap:4px;flex-shrink:0">'
                + '<button class="ph-star menu_button" title="' + (snap.starred ? '取消收藏' : '收藏') + '" style="font-size:12px;padding:3px 6px">' + starIcon + '</button>'
                + '<button class="ph-restore menu_button" title="恢复" style="font-size:12px;padding:3px 6px">⏪</button>'
                + '<button class="ph-export menu_button" title="导出" style="font-size:12px;padding:3px 6px">📤</button>'
                + '<button class="ph-delete menu_button" title="删除" style="font-size:12px;padding:3px 6px">🗑️</button>'
                + '</div></div>'
            );
            $item.find('.ph-star').on('click', function () {
                toggleStar(name, snap.id);
                renderSnapshotList();
            });
            $item.find('.ph-restore').on('click', async function () {
                // 对比当前和备份的差异
                var diffText = '';
                var currentInfo = getBestCurrentPresetInfo();
                if (currentInfo) {
                    var diffs = diffPresets(currentInfo.data, snap.data, 'restore');
                    diffText = '\n\n【当前 vs 备份的区别】\n' + diffs.join('\n');
                }
                if (!confirm('要把「' + name + '」恢复到这个版本吗？\n' + snap.label + '\n' + fmtTime(snap.ts) + diffText + '\n\n当前预设会被覆盖，页面会自动刷新。')) return;
                await restoreSnapshot(name, snap);
            });
            $item.find('.ph-export').on('click', function () {
                var pwd = prompt('请输入导出密码：');
                if (!pwd || hash(pwd) !== 'd4176620') {
                    toastr.error('密码错误。');
                    return;
                }
                var blob = new Blob([JSON.stringify(snap.data, null, 2)], { type: 'application/json' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = name + '_' + fmtTime(snap.ts).replace(/[.: ]/g, '-') + '.json';
                a.click();
                URL.revokeObjectURL(url);
                toastr.success('已导出。');
            });
            $item.find('.ph-delete').on('click', function () {
                var msg = snap.starred ? '⚠️ 这是收藏版本！确定要删除吗？\n' + snap.label : '删除这个备份？\n' + snap.label;
                if (!confirm(msg)) return;
                deleteSnap(name, snap.id);
                renderSnapshotList();
                toastr.info('已删除。');
            });
            $list.append($item);
        })(snaps[i]);
    }
    var starredCount = snaps.filter(function (s) { return s.starred; }).length;
    var unstarredCount = snaps.length - starredCount;
    var statsText = '本预设：备份' + unstarredCount + '/最多' + getSettings().maxSnapshotsPerPreset + '个，收藏' + starredCount + '/最多10个';
    $list.append('<div style="padding:4px 8px;text-align:center;font-size:0.8em;opacity:0.5;border-top:1px solid rgba(128,128,128,0.2);margin-top:2px">' + statsText + '</div>');
}

function manualSnapshotNow() {
    var customLabel = jQuery('#ph_manual_label').val().trim();
    var info = getBestCurrentPresetInfo();
    if (!info) {
        toastr.error('无法读取当前预设，请切换一次预设后重试。');
        return;
    }

    var snapshotLabel = customLabel;
    if (!snapshotLabel) {
        var existingSnaps = getSnapshots(info.name);
        if (existingSnaps.length > 0) {
            var diffs = diffPresets(existingSnaps[0].data, info.data, 'changelog');
            var realDiffs = diffs.filter(function (d) { return d !== '没有检测到差异'; });
            snapshotLabel = realDiffs.length > 0 ? realDiffs.slice(0, 3).join('；') : '手动备份（无变化）';
        } else {
            snapshotLabel = '首次手动备份';
        }
    }

    var snap = saveSnapshot(info.name, info.data, 'manual', snapshotLabel);
    if (snap) {
        toastr.success('已备份：' + info.name);
    } else {
        toastr.info('内容没有变化，跳过。');
    }
    jQuery('#ph_manual_label').val('');
    // 手动备份针对的是当前真正生效的预设，完成后跳到它的历史，避免看着A却备份了B的错觉。
    jQuery('#ph_filter_name').val(info.name);
    renderSnapshotList();
}

// ========== 初始化 ==========

jQuery(async function () {
    getSettings();

    // 清理旧版本(v2.1)残留的带 :: 前缀的数据
    var s = getSettings();
    var keysToDelete = [];
    for (var k in s.snapshots) {
        if (k.indexOf('::') !== -1) keysToDelete.push(k);
    }
    if (keysToDelete.length > 0) {
        for (var d = 0; d < keysToDelete.length; d++) {
            delete s.snapshots[keysToDelete[d]];
        }
        saveSettingsDebounced();
        console.log('[PresetHistory] 已清理 ' + keysToDelete.length + ' 个旧版本残留数据');
    }

    addUI();
    // 始终拦截以便缓存手动备份数据；开关只控制是否自动生成快照。
    installFetchInterceptor();
    installDirectPresetCapture();
    installPresetSwitchCapture();
    console.log('[PresetHistory Test] v2.2.3 已加载');
    toastr.success('预设历史测试版 v2.2.3 已加载', '🧪');
});
