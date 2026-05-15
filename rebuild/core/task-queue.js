'use strict';

/**
 * 작업 큐 — 외부 자원(OmniVoice GPU / Flow Playwright / Grok 브라우저)이 단일이라
 * task 단위로 직렬화. 멀티 탭 환경에서 TTS / 이미지 / 비디오를 자원별 큐로 분리한다.
 *
 * 사용 흐름:
 *   const q = new TaskQueue('tts', 1, snap => updateUI(snap));
 *   const taskId = q.push({
 *     projectId: 'p_xxx',
 *     label: 'TTS s001',
 *     run: async () => { ...synthesize... return result; },
 *     onSuccess: r => {...},
 *     onError: e => {...},
 *   });
 *   q.cancelProject('p_xxx');  // 탭 닫기 시 대기 task 제거 (실행 중은 둠)
 */

class TaskQueue {
  /**
   * @param {string} name - 'tts' | 'image' | 'video'
   * @param {number} maxConcurrency - 동시 실행 수 (외부 자원 단일이라 기본 1)
   * @param {(snap: object) => void} onChange - 큐 변경 시 호출 (UI 갱신용)
   */
  constructor(name, maxConcurrency = 1, onChange = null) {
    this.name = name;
    this.max = Math.max(1, maxConcurrency | 0);
    this.queue = [];        // 대기 task
    this.running = [];      // 실행 중 task (max 까지)
    this.onChange = onChange;
    this._idSeq = 0;
  }

  /**
   * 큐에 task 추가. 즉시 dispatch.
   * @param {{ projectId: string, label?: string, run: () => Promise<any>, onSuccess?: Function, onError?: Function, id?: string }} task
   * @returns {string} taskId
   */
  push(task) {
    if (!task || typeof task.run !== 'function') {
      throw new Error(`TaskQueue[${this.name}].push: task.run (async) 필수`);
    }
    if (!task.projectId) {
      throw new Error(`TaskQueue[${this.name}].push: task.projectId 필수 (탭 닫기 cancel 용)`);
    }
    task.id = task.id || `t_${this.name}_${++this._idSeq}`;
    task.status = 'queued';
    task.queuedAt = Date.now();
    this.queue.push(task);
    this._emit();
    this._dispatch();
    return task.id;
  }

  /** 다음 task 실행 — running < max 이면서 queue 비어있지 않을 때만. */
  _dispatch() {
    while (this.running.length < this.max && this.queue.length > 0) {
      const t = this.queue.shift();
      t.status = 'running';
      t.startedAt = Date.now();
      this.running.push(t);
      this._emit();
      Promise.resolve()
        .then(() => t.run())
        .then((r) => {
          t.status = 'done';
          t.finishedAt = Date.now();
          if (typeof t.onSuccess === 'function') {
            try { t.onSuccess(r); } catch (e) { console.error(`[TaskQueue:${this.name}] onSuccess`, e); }
          }
        })
        .catch((e) => {
          t.status = 'error';
          t.finishedAt = Date.now();
          t.error = e;
          if (typeof t.onError === 'function') {
            try { t.onError(e); } catch (ee) { console.error(`[TaskQueue:${this.name}] onError`, ee); }
          } else {
            console.error(`[TaskQueue:${this.name}] task ${t.id} 실패:`, e);
          }
        })
        .finally(() => {
          const i = this.running.indexOf(t);
          if (i >= 0) this.running.splice(i, 1);
          this._emit();
          this._dispatch();
        });
    }
  }

  /**
   * 특정 projectId 의 대기 task 모두 제거. 실행 중(running) 은 그대로 둠.
   * (실행 중인 결과는 디스크에 이미 부분 저장될 수 있어 abort 보다 자연 종료가 안전)
   */
  cancelProject(projectId) {
    if (!projectId) return 0;
    const before = this.queue.length;
    this.queue = this.queue.filter(t => t.projectId !== projectId);
    const removed = before - this.queue.length;
    if (removed > 0) this._emit();
    return removed;
  }

  /** 현재 큐 상태 스냅샷 — UI 갱신용. */
  snapshot() {
    return {
      name: this.name,
      max: this.max,
      running: this.running.length,
      queued: this.queue.length,
      runningTasks: this.running.map(t => ({
        id: t.id, projectId: t.projectId, label: t.label, startedAt: t.startedAt,
      })),
      byProject: this._byProject(),
    };
  }

  /** 프로젝트별 대기 + 실행 카운트 — { [projectId]: { queued, running } } */
  _byProject() {
    const m = {};
    const bump = (pid, k) => {
      if (!m[pid]) m[pid] = { queued: 0, running: 0 };
      m[pid][k]++;
    };
    for (const t of this.queue) bump(t.projectId, 'queued');
    for (const t of this.running) bump(t.projectId, 'running');
    return m;
  }

  _emit() {
    if (typeof this.onChange === 'function') {
      try { this.onChange(this.snapshot()); }
      catch (e) { console.error(`[TaskQueue:${this.name}] onChange`, e); }
    }
  }
}

module.exports = { TaskQueue };
