'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const AppError = require('../../core/errors/AppError');
const ToolInterface = require('../../core/tools/tool.interface');

const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_OUTPUT_CHARS = 30000;
const MAX_SEARCH_FILE_BYTES = 128 * 1024;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_DEPTH = 8;
const MAX_CHANGES = 10;
const MAX_CHANGE_BYTES = 32 * 1024;

const BLOCKED_DIRECTORY_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.gradle',
  'coverage', 'vendor', 'data', 'target', 'out', '.ssh'
]);

const ALLOWED_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);

function fail(message, statusCode, code) {
  throw new AppError(message, statusCode, code);
}

function normalizeRelativePath(value, fallback = '.') {
  if (value === undefined || value === null || value === '') value = fallback;
  if (typeof value !== 'string' || value.length > 512 || value.includes('\0')) {
    fail('مسار مساحة العمل غير صالح', 400, 'WORKSPACE_PATH_INVALID');
  }

  const normalizedSeparators = value.trim().replace(/\\/g, '/');
  if (
    !normalizedSeparators ||
    normalizedSeparators.startsWith('/') ||
    path.win32.isAbsolute(value) ||
    normalizedSeparators.split('/').some(part => part === '..')
  ) {
    fail('يجب أن يكون المسار نسبيًا وداخل مساحة العمل', 403, 'WORKSPACE_PATH_FORBIDDEN');
  }

  const normalized = path.posix.normalize(normalizedSeparators);
  if (normalized === '..' || normalized.startsWith('../')) {
    fail('المسار يتجاوز مساحة العمل المسموحة', 403, 'WORKSPACE_PATH_FORBIDDEN');
  }
  return normalized || '.';
}

function isSensitivePath(relativePath) {
  const segments = relativePath.split('/').filter(Boolean);
  const lowerSegments = segments.map(segment => segment.toLowerCase());
  if (lowerSegments.some(segment => BLOCKED_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.some(segment => /(secret|credential|private[-_]?key)/i.test(segment))) return true;

  const basename = (segments.at(-1) || '').toLowerCase();
  if (basename === '.env') return true;
  if (basename.startsWith('.env.') && !ALLOWED_ENV_EXAMPLES.has(basename)) return true;
  if (['.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json'].includes(basename)) return true;
  if (/(secret|credential|private[-_]?key)/i.test(basename)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(basename)) return true;
  return false;
}

function assertAllowedPath(relativePath) {
  if (isSensitivePath(relativePath)) {
    fail('قراءة هذا المسار محظورة افتراضيًا لحماية بيانات الاعتماد والبيانات الخاصة', 403, 'WORKSPACE_SENSITIVE_PATH_DENIED');
  }
}

function inputObject(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

function relativeJoin(parent, name) {
  return parent === '.' ? name : path.posix.join(parent, name);
}

async function statAllowed(projectBuilder, relativePath) {
  let absolutePath;
  try {
    absolutePath = projectBuilder.policy.assertRead(relativePath);
    if (typeof projectBuilder.policy._assertNoSymlinkComponents === 'function') {
      projectBuilder.policy._assertNoSymlinkComponents(absolutePath);
    }
  } catch (_) {
    fail('المسار غير مسموح به ضمن مساحة العمل أو يحتوي رابطًا رمزيًا', 403, 'WORKSPACE_PATH_FORBIDDEN');
  }

  try {
    const realPath = await fs.realpath(absolutePath);
    const realRoot = projectBuilder.policy.realAllowedRoot;
    const realRelative = path.relative(realRoot, realPath).split(path.sep).join('/');
    if (realRelative === '..' || realRelative.startsWith('../') || path.isAbsolute(realRelative)) {
      fail('المسار يتجاوز مساحة العمل المسموحة', 403, 'WORKSPACE_PATH_FORBIDDEN');
    }
    assertAllowedPath(realRelative || '.');
    return { absolutePath, realPath, stats: await fs.stat(absolutePath) };
  } catch (error) {
    if (error.code === 'ENOENT') fail('الملف أو المجلد غير موجود', 404, 'WORKSPACE_PATH_NOT_FOUND');
    throw error;
  }
}


function projectChangeSetHash(changes) {
  return crypto.createHash('sha256').update(JSON.stringify(changes), 'utf8').digest('hex');
}

function projectWorkspaceId(projectBuilder) {
  return crypto.createHash('sha256')
    .update(path.resolve(projectBuilder.policy.realAllowedRoot), 'utf8')
    .digest('hex');
}

function hasReceiptIdentity(context) {
  return context && typeof context.operationId === 'string' &&
    context.operationId.length > 0 && context.operationId.length <= 256 &&
    typeof context.tenantId === 'string' &&
    context.tenantId.length > 0 && context.tenantId.length <= 128;
}

function createWorkspaceTools(projectBuilder, { operationReceiptStore = null } = {}) {
  if (!projectBuilder || !projectBuilder.workspace || !projectBuilder.policy) {
    throw new TypeError('projectBuilder with workspace policy is required');
  }

  const readFile = new ToolInterface({
    name: 'workspace.read',
    description: 'قراءة ملف نصي مسموح داخل مساحة عمل ORIENT ONE مع حماية المسارات الحساسة',
    capabilities: ['workspace.read'],
    risk: 'low',
    execute: async (input) => {
      const payload = inputObject(input);
      const relativePath = normalizeRelativePath(typeof input === 'string' ? input : payload.path);
      assertAllowedPath(relativePath);
      const { stats } = await statAllowed(projectBuilder, relativePath);
      if (!stats.isFile()) fail('المسار ليس ملفًا عاديًا', 400, 'WORKSPACE_NOT_A_FILE');
      if (stats.size > MAX_READ_BYTES) fail('الملف أكبر من حد القراءة الآمن', 413, 'WORKSPACE_FILE_TOO_LARGE');

      const content = await projectBuilder.workspace.readText(relativePath);
      if (content.includes('\0')) fail('قراءة الملفات الثنائية غير مدعومة', 415, 'WORKSPACE_BINARY_FILE_DENIED');
      const digest = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      return {
        path: relativePath,
        bytes: Buffer.byteLength(content, 'utf8'),
        contentSha256: digest,
        content: content.slice(0, MAX_READ_OUTPUT_CHARS),
        truncated: content.length > MAX_READ_OUTPUT_CHARS
      };
    }
  });

  const listFiles = new ToolInterface({
    name: 'workspace.list',
    description: 'عرض ملفات ومجلدات مساحة العمل المسموحة دون كشف المسارات الحساسة',
    capabilities: ['workspace.read'],
    risk: 'low',
    execute: async (input) => {
      const payload = inputObject(input);
      const relativePath = normalizeRelativePath(typeof input === 'string' ? input : payload.path);
      assertAllowedPath(relativePath);
      const { stats } = await statAllowed(projectBuilder, relativePath);
      if (!stats.isDirectory()) fail('المسار ليس مجلدًا', 400, 'WORKSPACE_NOT_A_DIRECTORY');
      const entries = await projectBuilder.workspace.list(relativePath);
      const visible = entries
        .filter(entry => !entry.isSymbolicLink())
        .filter(entry => !isSensitivePath(relativeJoin(relativePath, entry.name)))
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        path: relativePath,
        entries: visible.slice(0, 200).map(entry => ({
          name: entry.name,
          path: relativeJoin(relativePath, entry.name),
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        })),
        truncated: visible.length > 200
      };
    }
  });

  const searchFiles = new ToolInterface({
    name: 'workspace.search',
    description: 'بحث نصي حرفي داخل ملفات المشروع المسموحة؛ لا ينفذ أوامر ولا يتصل بالإنترنت',
    capabilities: ['workspace.read'],
    risk: 'low',
    execute: async (input) => {
      const payload = inputObject(input);
      const query = String(typeof input === 'string' ? input : payload.query || '').trim();
      if (query.length < 2 || query.length > 200) {
        fail('عبارة البحث يجب أن تكون بين حرفين و200 حرف', 400, 'WORKSPACE_SEARCH_QUERY_INVALID');
      }
      const root = normalizeRelativePath(payload.path, '.');
      assertAllowedPath(root);
      const needle = query.toLocaleLowerCase();
      const results = [];
      let visitedFiles = 0;
      let truncated = false;

      const walk = async (directory, depth) => {
        if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_SEARCH_RESULTS || visitedFiles >= MAX_SEARCH_FILES) {
          truncated = true;
          return;
        }

        try {
          const { stats } = await statAllowed(projectBuilder, directory);
          if (!stats.isDirectory()) return;
        } catch (error) {
          if (['WORKSPACE_PATH_FORBIDDEN', 'WORKSPACE_SENSITIVE_PATH_DENIED', 'WORKSPACE_PATH_NOT_FOUND'].includes(error.code)) return;
          throw error;
        }

        let entries;
        try {
          entries = await projectBuilder.workspace.list(directory);
        } catch (error) {
          if (error.code === 'WORKSPACE_PATH_FORBIDDEN' || /denied|escapes allowed root/i.test(error.message)) return;
          throw error;
        }

        for (const entry of entries) {
          if (results.length >= MAX_SEARCH_RESULTS || visitedFiles >= MAX_SEARCH_FILES) {
            truncated = true;
            return;
          }
          if (entry.isSymbolicLink()) continue;
          const relativePath = relativeJoin(directory, entry.name);
          if (isSensitivePath(relativePath)) continue;

          if (entry.isDirectory()) {
            if (depth < MAX_SEARCH_DEPTH) await walk(relativePath, depth + 1);
            else truncated = true;
            continue;
          }
          if (!entry.isFile()) continue;

          visitedFiles += 1;
          let stats;
          try {
            ({ stats } = await statAllowed(projectBuilder, relativePath));
          } catch (_) {
            continue;
          }
          if (stats.size > MAX_SEARCH_FILE_BYTES) continue;

          let content;
          try {
            content = await projectBuilder.workspace.readText(relativePath);
          } catch (_) {
            continue;
          }
          if (content.includes('\0')) continue;

          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            if (lines[index].toLocaleLowerCase().includes(needle)) {
              results.push({
                path: relativePath,
                line: index + 1,
                text: lines[index].slice(0, 240)
              });
              if (results.length >= MAX_SEARCH_RESULTS) {
                truncated = true;
                return;
              }
            }
          }
        }
      };

      await walk(root, 0);
      return { query, root, filesScanned: visitedFiles, results, truncated };
    }
  });

  const projectAudit = new ToolInterface({
    name: 'project.audit',
    description: 'تدقيق قراءة فقط لبنية المشروع والفجوات الهندسية',
    capabilities: ['workspace.read'],
    risk: 'low',
    execute: async () => {
      const audit = await projectBuilder.auditor.audit();
      return {
        status: audit.status,
        projectType: audit.projectType,
        score: audit.score,
        recommendation: audit.recommendation,
        findings: audit.findings,
        gaps: audit.gaps,
        strengths: audit.strengths,
        definitionOfDone: audit.definitionOfDone
      };
    }
  });

  const proposeChanges = new ToolInterface({
    name: 'project.propose_changes',
    description: 'إنشاء اقتراح تغييرات صريح دون تعديل الملفات',
    capabilities: ['workspace.read'],
    risk: 'low',
    execute: async (input, context = {}) => {
      const payload = inputObject(input);
      const rawProposals = Array.isArray(payload.proposals) ? payload.proposals : [];
      if (rawProposals.length > MAX_CHANGES) fail('عدد التغييرات يتجاوز الحد المسموح', 413, 'CHANGE_SET_TOO_LARGE');

      const proposals = rawProposals.map(proposal => {
        if (!proposal || typeof proposal !== 'object') fail('صيغة الاقتراح غير صالحة', 400, 'CHANGE_PROPOSAL_INVALID');
        if (proposal.action !== 'create' && proposal.action !== 'update') fail('الإجراء المسموح هو create أو update', 400, 'CHANGE_ACTION_INVALID');
        const relativePath = normalizeRelativePath(proposal.path);
        assertAllowedPath(relativePath);
        if (typeof proposal.content !== 'string' || Buffer.byteLength(proposal.content, 'utf8') > MAX_CHANGE_BYTES) {
          fail('محتوى الاقتراح غير صالح أو أكبر من الحد الآمن', 413, 'CHANGE_CONTENT_TOO_LARGE');
        }
        if (proposal.action === 'update' && !/^[a-f0-9]{64}$/i.test(String(proposal.expectedContentSha256 || ''))) {
          fail('تحديث الملف يتطلب expectedContentSha256', 400, 'CHANGE_PRECONDITION_REQUIRED');
        }
        return {
          action: proposal.action,
          path: relativePath,
          content: proposal.content,
          ...(proposal.action === 'update' ? { expectedContentSha256: proposal.expectedContentSha256.toLowerCase() } : {})
        };
      });

      const goal = String(payload.goal || context.goal || context.plan?.intent || 'Review the current project.').trim().slice(0, 500);
      const buildPlan = await projectBuilder.plan({ goal });
      const validation = await projectBuilder.validateProposals({ proposals });
      if (!validation.valid) {
        fail('اقتراح التغييرات غير صالح', 400, 'CHANGE_PROPOSAL_INVALID');
      }

      return {
        ...projectBuilder.proposeChanges({ buildPlan, proposals }),
        buildPlan
      };
    }
  });

  const executeChanges = new ToolInterface({
    name: 'project.execute_change',
    description: 'تطبيق ChangeSet صريح بعد اجتياز تفويض المخاطر والموافقة البشرية والتحقق',
    capabilities: ['workspace.write'],
    risk: 'high',
    execute: async (input, context = {}) => {
      const payload = inputObject(input);
      const rawChanges = Array.isArray(payload.changeSet?.changes)
        ? payload.changeSet.changes
        : Array.isArray(payload.proposals)
          ? payload.proposals
          : [];

      if (rawChanges.length === 0) fail('لا توجد تغييرات صريحة لتطبيقها', 400, 'CHANGE_SET_EMPTY');
      if (rawChanges.length > MAX_CHANGES) fail('عدد التغييرات يتجاوز الحد المسموح', 413, 'CHANGE_SET_TOO_LARGE');

      const changes = rawChanges.map(change => {
        if (!change || typeof change !== 'object') fail('صيغة التغيير غير صالحة', 400, 'CHANGE_PROPOSAL_INVALID');
        const action = change.action;
        if (action !== 'create' && action !== 'update') fail('الإجراء المسموح هو create أو update', 400, 'CHANGE_ACTION_INVALID');
        const relativePath = normalizeRelativePath(change.path);
        assertAllowedPath(relativePath);
        if (typeof change.content !== 'string' || Buffer.byteLength(change.content, 'utf8') > MAX_CHANGE_BYTES) {
          fail('محتوى التغيير غير صالح أو أكبر من الحد الآمن', 413, 'CHANGE_CONTENT_TOO_LARGE');
        }
        if (action === 'update' && !/^[a-f0-9]{64}$/i.test(String(change.expectedContentSha256 || ''))) {
          fail('تحديث الملف يتطلب expectedContentSha256 لمنع الكتابة فوق تعديل أحدث', 400, 'CHANGE_PRECONDITION_REQUIRED');
        }
        return {
          action,
          path: relativePath,
          content: change.content,
          ...(action === 'update' ? { expectedContentSha256: change.expectedContentSha256.toLowerCase() } : {})
        };
      });

      const changeSet = { changes };
      const receiptIdentity = operationReceiptStore && hasReceiptIdentity(context)
        ? {
            operationId: context.operationId,
            tenantId: context.tenantId,
            workspaceId: projectWorkspaceId(projectBuilder),
            changeSetHash: projectChangeSetHash(changes)
          }
        : null;

      // A durable receipt is the only authority for replaying a previously
      // verified project operation. Identity mismatches and corrupt receipts fail closed.
      if (receiptIdentity) {
        const existingReceipt = operationReceiptStore.read(receiptIdentity);
        if (existingReceipt) {
          if (existingReceipt.workspaceId !== receiptIdentity.workspaceId ||
              existingReceipt.changeSetHash !== receiptIdentity.changeSetHash) {
            fail('معرّف العملية مرتبط بتغيير مختلف ولا يجوز إعادة استخدامه', 409, 'PROJECT_OPERATION_RECEIPT_IDENTITY_CONFLICT');
          }
          return existingReceipt.result;
        }
      }

      const definitionOfDone = {
        required: ['Every changed file matches the approved proposed content.'],
        satisfied: false
      };
      const checks = [{
        id: 'changed-files-match-proposal',
        run: async ({ workspace }) => {
          for (const change of changes) {
            if (!(await workspace.exists(change.path))) return { passed: false, path: change.path };
            if ((await workspace.readText(change.path)) !== change.content) return { passed: false, path: change.path };
          }
          return { passed: true, checkedFiles: changes.length };
        }
      }];

      const result = await projectBuilder.execute({
        plan: payload.buildPlan || await projectBuilder.plan({
          goal: String(payload.goal || 'Apply the explicit approved change set.').trim().slice(0, 500)
        }),
        changeSet,
        definitionOfDone,
        checks
      });
      const toolResult = {
        status: result.status,
        changes: changes.map(({ action, path: changePath }) => ({ action, path: changePath })),
        verification: result.verification || null,
        policy: result.policy || null,
        rollback: result.rollback || null,
        error: result.error ? {
          name: result.error.name || 'Error',
          code: result.error.code || null,
          message: String(result.error.message || 'Change execution failed').slice(0, 500)
        } : null
      };

      // Persist only after the builder verifies every requested change. If the
      // process crashes before this durable write, reconciliation remains unknown.
      if (receiptIdentity && toolResult.status === 'verified' &&
          toolResult.verification?.status === 'passed' &&
          toolResult.verification?.failed === 0) {
        operationReceiptStore.write({ ...receiptIdentity, result: toolResult });
      }
      return toolResult;
    },
    reconcile: async (input, context = {}) => {
      // This is read-after-crash reconciliation only. It never mutates files:
      // all proposed contents must already be present to claim completion.
      const payload = inputObject(input);
      const rawChanges = Array.isArray(payload.changeSet?.changes)
        ? payload.changeSet.changes
        : Array.isArray(payload.proposals)
          ? payload.proposals
          : [];
      if (rawChanges.length === 0 || rawChanges.length > MAX_CHANGES) {
        return { status: 'conflict', reason: 'invalid_change_set' };
      }

      const changes = [];
      for (const change of rawChanges) {
        if (!change || typeof change !== 'object' ||
            (change.action !== 'create' && change.action !== 'update') ||
            typeof change.content !== 'string' ||
            Buffer.byteLength(change.content, 'utf8') > MAX_CHANGE_BYTES) {
          return { status: 'conflict', reason: 'invalid_change' };
        }
        let relativePath;
        try {
          relativePath = normalizeRelativePath(change.path);
          assertAllowedPath(relativePath);
        } catch {
          return { status: 'conflict', reason: 'path_not_allowed' };
        }
        if (change.action === 'update' &&
            !/^[a-f0-9]{64}$/i.test(String(change.expectedContentSha256 || ''))) {
          return { status: 'conflict', reason: 'missing_update_precondition' };
        }
        changes.push({
          action: change.action,
          path: relativePath,
          content: change.content,
          ...(change.action === 'update'
            ? { expectedContentSha256: change.expectedContentSha256.toLowerCase() }
            : {})
        });
      }

      const receiptIdentity = operationReceiptStore && hasReceiptIdentity(context)
        ? {
            operationId: context.operationId,
            tenantId: context.tenantId,
            workspaceId: projectWorkspaceId(projectBuilder),
            changeSetHash: projectChangeSetHash(changes)
          }
        : null;
      let receipt = null;
      if (receiptIdentity) {
        try {
          receipt = operationReceiptStore.read(receiptIdentity);
        } catch {
          return { status: 'conflict', reason: 'operation_receipt_corrupt' };
        }
        if (receipt && (receipt.workspaceId !== receiptIdentity.workspaceId ||
            receipt.changeSetHash !== receiptIdentity.changeSetHash)) {
          return { status: 'conflict', reason: 'operation_receipt_identity_mismatch' };
        }
      }

      let alreadyApplied = 0;
      let notApplied = 0;
      for (const change of changes) {
        const exists = await projectBuilder.workspace.exists(change.path);
        if (change.action === 'create') {
          if (!exists) {
            notApplied += 1;
            continue;
          }
          if ((await projectBuilder.workspace.readText(change.path)) === change.content) {
            alreadyApplied += 1;
          } else {
            return { status: 'conflict', reason: 'created_path_has_different_content', path: change.path };
          }
          continue;
        }

        if (!exists) {
          return { status: 'conflict', reason: 'updated_path_missing', path: change.path };
        }
        const currentContent = await projectBuilder.workspace.readText(change.path);
        if (currentContent === change.content) {
          alreadyApplied += 1;
          continue;
        }
        const currentHash = crypto.createHash('sha256').update(currentContent, 'utf8').digest('hex');
        if (currentHash === change.expectedContentSha256) {
          notApplied += 1;
          continue;
        }
        return { status: 'conflict', reason: 'updated_path_matches_neither_precondition_nor_proposal', path: change.path };
      }

      if (alreadyApplied === changes.length) {
        if (receipt) {
          return { status: 'completed', result: receipt.result };
        }
        // Matching file contents prove only the current post-state, not that this
        // logical operation produced it. Never infer completion without a durable receipt.
        return {
          status: 'conflict',
          reason: 'operation_receipt_missing',
          observations: changes.map(({ action, path: changePath }) => ({
            action,
            path: changePath,
            postStateMatches: true
          }))
        };
      }

      // A partially applied or untouched change set is not replayed here. The
      // caller fails closed and requires an explicit repair/review decision.
      return {
        status: 'conflict',
        reason: alreadyApplied > 0 ? 'partially_applied_change_set' : 'no_changes_proven_applied'
      };
    }
  });

  return [readFile, listFiles, searchFiles, projectAudit, proposeChanges, executeChanges];
}

module.exports = createWorkspaceTools;
