/**
 * WebDAV 辅助：使用 fetch + Basic 认证读写远程 JSON。
 * 供扩展页面在获得对应 host 权限后调用。
 */
(function (global) {
    'use strict';

    function normalizeBaseUrl(base) {
        let b = (base || '').trim();
        if (!b) throw new Error('服务器地址不能为空');
        if (!/^https?:\/\//i.test(b)) {
            b = 'https://' + b;
        }
        return b.endsWith('/') ? b : b + '/';
    }

    /**
     * @param {string} base 服务器根地址，如 https://cloud.example/remote.php/dav/files/user/
     * @param {string} remotePath 相对路径，如 TabManager/rules.json
     */
    function resolveFileUrl(base, remotePath) {
        const b = normalizeBaseUrl(base);
        const p = String(remotePath || '').trim().replace(/^\/+/, '');
        if (!p) throw new Error('远程文件路径不能为空');
        return new URL(p, b).href;
    }

    function originPatternFromUrl(urlString) {
        try {
            const u = new URL(urlString.trim());
            return `${u.origin}/*`;
        } catch {
            return null;
        }
    }

    /** UTF-8 安全的 Basic 编码 */
    function basicAuthHeader(username, password) {
        const u = username != null ? String(username) : '';
        const p = password != null ? String(password) : '';
        const raw = `${u}:${p}`;
        const bytes = new TextEncoder().encode(raw);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const token = btoa(binary);
        return `Basic ${token}`;
    }

    async function fetchWithAuth(url, options) {
        const { method = 'GET', body, username, password, headers = {} } = options || {};
        const h = Object.assign({}, headers);
        h.Authorization = basicAuthHeader(username, password);
        h['Cache-Control'] = 'no-store';
        return fetch(url, {
            method,
            body,
            headers: h,
            cache: 'no-store',
        });
    }

    async function getText(url, auth) {
        const res = await fetchWithAuth(url, Object.assign({ method: 'GET' }, auth));
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
    }

    async function putText(url, text, auth) {
        const res = await fetchWithAuth(url, Object.assign({
            method: 'PUT',
            body: text,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }, auth));
        const bodyText = await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, bodyText };
    }

    async function headRequest(url, auth) {
        const res = await fetchWithAuth(url, Object.assign({ method: 'HEAD' }, auth));
        return { ok: res.ok, status: res.status };
    }

    function interpretFileProbe(status) {
        if (status === 401 || status === 403) {
            return { ok: false, status, message: '认证无效或无权访问' };
        }
        if (status === 404) {
            return { ok: true, status, message: '' };
        }
        if (status >= 200 && status < 300) {
            return { ok: true, status, message: '' };
        }
        return { ok: false, status, message: `HTTP ${status}` };
    }

    /**
     * 测试连接：优先 HEAD（不下载文件内容，只测 URL + 认证 + 状态码）。
     * 若服务端不支持 HEAD（405/501），再回退为 GET（会读取响应体）。
     */
    async function testConnection(fileUrl, auth) {
        const head = await headRequest(fileUrl, auth);
        if (head.status !== 405 && head.status !== 501) {
            return interpretFileProbe(head.status);
        }
        const { status } = await getText(fileUrl, auth);
        if (status === 405 || status === 501) {
            return {
                ok: false,
                status,
                message: '服务器不支持 HEAD/GET',
            };
        }
        return interpretFileProbe(status);
    }

    global.TabManagerWebDAV = {
        normalizeBaseUrl,
        resolveFileUrl,
        originPatternFromUrl,
        getText,
        putText,
        testConnection,
    };
}(typeof self !== 'undefined' ? self : this));
