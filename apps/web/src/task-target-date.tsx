import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import { isValidTaskTargetDate } from '../../../packages/contracts/src/task-target-date.js';
import {
  isTaskTargetDateOverdue,
  localCalendarDate,
  millisecondsUntilNextLocalDay,
} from './project-task-target-date.js';

/** Keep relative date labels and filters current without changing Task data. */
export function useLocalCalendarDate(): string {
  const [today, setToday] = useState(() => localCalendarDate());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function update() {
      clearTimeout(timer);
      const now = new Date();
      setToday(localCalendarDate(now));
      timer = setTimeout(update, millisecondsUntilNextLocalDay(now));
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') update();
    }
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
  return today;
}

type DatedTask = Pick<Task, 'targetDate' | 'status'>;

function TaskTargetDateValue({ task, today }: { task: DatedTask; today: string }) {
  if (!isValidTaskTargetDate(task.targetDate)) return null;
  const overdue = isTaskTargetDateOverdue(task, today);
  const isToday = task.targetDate === today;
  return (
    <span
      className={`badge${overdue ? ' amber' : ''}`}
      title="目标日期按日历日期保存；今天和逾期按浏览器本地日期判断，已完成、已取消不计逾期。"
    >
      目标日期 <time dateTime={task.targetDate}>{task.targetDate}</time>
      {overdue ? ' · 已逾期' : isToday ? ' · 今天（本地）' : ''}
    </span>
  );
}

function CurrentTaskTargetDate({ task }: { task: DatedTask }) {
  const today = useLocalCalendarDate();
  return <TaskTargetDateValue task={task} today={today} />;
}

/** Project views can share their filter's day clock; isolated rows own a local clock. */
export function TaskTargetDate({ task, today }: { task: DatedTask; today?: string }) {
  if (!isValidTaskTargetDate(task.targetDate)) return null;
  return today === undefined ? (
    <CurrentTaskTargetDate task={task} />
  ) : (
    <TaskTargetDateValue task={task} today={today} />
  );
}
