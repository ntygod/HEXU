import { AssistancePage } from './assistance.js';
import { useEffect, useState } from 'react';
import { Empty } from '../../../packages/ui/src/index.js';
import { Link, usePath, useRouteChrome } from './state.js';
import { Workbench } from './workbench.js';
import { Projects, ProjectPage } from './projects.js';
import { Results, ResultPage } from './results.js';
import { BranchComparisonPage } from './branch-comparison.js';
import { TaskPage } from './task-workspace.js';
import { Settings } from './settings.js';
import { Search } from './command-menu.js';
import { AppShell } from './shell.js';
import { NewTask } from './forms.js';
export function App() {
  const path = usePath();
  useRouteChrome(path);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.repeat) {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const segment = path.split('/').filter(Boolean);
  const active = segment[0] ?? 'workbench';
  return (
    <>
      <AppShell key={path} onSearch={() => setSearchOpen(true)}>
        {active === 'workbench' ? (
          <Workbench />
        ) : active === 'projects' ? (
          segment[1] ? (
            <ProjectPage id={segment[1]} key={segment[1]} />
          ) : (
            <Projects />
          )
        ) : active === 'tasks' && segment[1] ? (
          segment[2] === 'compare' && segment[3] ? (
            <BranchComparisonPage taskId={segment[1]} groupId={segment[3]} key={path} />
          ) : (
            <TaskPage id={segment[1]} key={segment[1]} />
          )
        ) : active === 'results' ? (
          segment[1] ? (
            <ResultPage
              id={segment[1]}
              revisionId={segment[2] === 'versions' ? segment[3] : undefined}
              key={path}
            />
          ) : (
            <Results />
          )
        ) : active === 'assistances' ? (
          <AssistancePage id={segment[1]} key={segment[1] ?? 'inbox'} />
        ) : active === 'settings' ? (
          <Settings />
        ) : (
          <Empty title="没有找到这个页面">
            <Link to="/" className="button primary">
              返回工作台
            </Link>
          </Empty>
        )}
      </AppShell>
      {searchOpen && (
        <Search
          onClose={() => setSearchOpen(false)}
          onNewTask={() => {
            setSearchOpen(false);
            setNewTaskOpen(true);
          }}
        />
      )}
      {newTaskOpen && <NewTask onClose={() => setNewTaskOpen(false)} />}
    </>
  );
}
