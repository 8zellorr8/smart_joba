import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "./api";
import type { Role, Session, User, Workspace } from "./api";
import { Icon } from "./icons";
import { messages as t } from "./locales/kk";
import { ImportPage } from "./ImportPage";

type Screen = "loading" | "login" | "workspace" | "error";
const roleNames: Record<Role, string> = {
  admin: t.roleAdmin,
  scheduler: t.roleScheduler,
  approver: t.roleApprover,
  teacher: t.roleTeacher,
  student: t.roleStudent,
};
const permissionNames: Record<string, string> = {
  "accounts.prepare": "Аккаунттарды дайындау",
  "catalog.manage": "Анықтамалықтарды басқару",
  "calendar.manage": "Оқу күнтізбесін басқару",
  "import.source.read": "Бастапқы деректерді қарау",
  "import.write": "Деректерді импорттау",
  "draft.read": "Кесте жобасын қарау",
  "draft.edit": "Кесте жобасын өңдеу",
  "generator.run": "Кестені автоматты құрастыру",
  "draft.submit": "Жобаны келісуге жіберу",
  "draft.approve": "Кесте жобасын бекіту",
  "draft.reject": "Жобаны түзетуге қайтару",
  "draft.publish": "Бекітілген кестені жариялау",
  "publication.read": "Жарияланған кестені қарау",
  "publication.export": "Жарияланған кестені жүктеу",
  "publication.read.own": "Өз сабақ кестесін қарау",
  "publication.export.own": "Өз сабақ кестесін жүктеу",
  "publication.read.group": "Өз тобының кестесін қарау",
  "publication.export.group": "Өз тобының кестесін жүктеу",
};

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t.serverError;
  if (error.status === 0) return t.connectionError;
  if (error.status === 429) return t.rateLimited;
  if (error.code === "AUTH_INVALID_CREDENTIALS") return t.invalidCredentials;
  if (error.code === "CSRF_INVALID") return t.sessionError;
  if (error.status === 403) return t.noAccess;
  return t.serverError;
}

function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className={`brand ${inverse ? "brand--inverse" : ""}`}>
      <span className="brand-mark">
        <img src="/favicon.svg?v=2" alt="" width="47" height="47" />
      </span>
      <span>
        <strong>{t.appName}</strong>
        <span className="brand-caption">{t.appDescription}</span>
      </span>
    </div>
  );
}

function Login({
  session,
  notice,
  onSuccess,
  onRefresh,
}: {
  session: Session;
  notice: string;
  onSuccess: (session: Session) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error && !busy) passwordRef.current?.focus();
  }, [error, busy]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setInvalid(false);
    try {
      const result = await api.login(
        email.trim(),
        password,
        session.csrf_token,
      );
      setPassword("");
      await onSuccess(result);
    } catch (problem) {
      setPassword("");
      setVisible(false);
      setError(errorMessage(problem));
      setInvalid(
        problem instanceof ApiError &&
          problem.code === "AUTH_INVALID_CREDENTIALS",
      );
      if (problem instanceof ApiError && problem.code === "CSRF_INVALID") {
        try {
          await onRefresh();
        } catch {
          setError(t.connectionError);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      <aside className="login-story" aria-label={t.appDescription}>
        <Brand inverse />
        <div className="story-content">
          <p className="eyebrow story-eyebrow">{t.loginEyebrow}</p>
          <h1>{t.loginTitle}</h1>
          <p className="story-intro">{t.loginDescription}</p>
          <div className="story-steps">
            {(
              [
                ["file", t.featureData, t.featureDataBody],
                ["calendar", t.featureSchedule, t.featureScheduleBody],
                ["layers", t.featurePublish, t.featurePublishBody],
              ] as const
            ).map(([icon, title, body], i) => (
              <div className="story-step" key={title}>
                <span className="story-step-icon">
                  <Icon name={icon} size={23} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </div>
                <span className="step-number">0{i + 1}</span>
              </div>
            ))}
          </div>
          <p className="story-roadmap">{t.roadmapHint}</p>
        </div>
        <span className="story-footer">
          <span className="local-dot" />
          {t.local}
        </span>
        <div className="story-decoration" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </aside>
      <main id="main" className="login-main">
        <div className="login-top">
          <span className="mobile-brand">
            <img src="/favicon.svg?v=2" alt="" width="32" height="32" />
            {t.appName}
          </span>
          <span className="language-label">
            Ққ <span>{t.language}</span>
          </span>
        </div>
        <div className="login-form-wrap">
          <span className="form-emblem">
            <Icon name="lock" size={25} />
          </span>
          <h2>{t.signInTitle}</h2>
          <p className="form-description">{t.signInDescription}</p>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <form onSubmit={submit} aria-busy={busy}>
            <div className="field">
              <label htmlFor="email">{t.email}</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.emailPlaceholder}
                required
                disabled={busy}
                aria-invalid={invalid}
                aria-describedby={error ? "login-error" : undefined}
              />
            </div>
            <div className="field">
              <label htmlFor="password">{t.password}</label>
              <div className="password-control">
                <input
                  ref={passwordRef}
                  id="password"
                  name="password"
                  type={visible ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={busy}
                  aria-invalid={invalid}
                  aria-describedby={error ? "login-error" : undefined}
                />
                <button
                  className="password-toggle"
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  aria-label={visible ? t.hidePassword : t.showPassword}
                  aria-pressed={visible}
                  disabled={busy}
                >
                  <Icon name={visible ? "eyeOff" : "eye"} size={21} />
                </button>
              </div>
            </div>
            <div className="form-message" aria-live="polite" aria-atomic="true">
              {error && (
                <p className="error-message" id="login-error">
                  <Icon name="alert" size={19} />
                  <span>{error}</span>
                </p>
              )}
            </div>
            <button
              type="submit"
              className="button button-primary login-submit"
              disabled={busy}
            >
              {busy ? (
                <>
                  <span className="spinner" />
                  {t.signingIn}
                </>
              ) : (
                <>
                  {t.signIn}
                  <Icon name="arrow" size={20} />
                </>
              )}
            </button>
          </form>
          <p className="account-help">{t.accountHelp}</p>
          <div className="secure-caption">
            <Icon name="lock" size={15} />
            {t.secureSession}
          </div>
        </div>
        <footer className="login-footer">
          <span>{t.footer}</span>
          <span>{t.stageFooter}</span>
        </footer>
      </main>
    </div>
  );
}

function WorkspaceScreen({
  user,
  workspace,
  onLogout,
  busy,
  error,
  csrfToken,
  onExpired,
}: {
  user: User;
  workspace: Workspace;
  onLogout: () => Promise<void>;
  busy: boolean;
  error: string;
  csrfToken: string;
  onExpired: () => void;
}) {
  const [view, setView] = useState<"overview" | "import">("overview");
  const activeRoles = workspace.role_codes;
  const isReader =
    activeRoles.length > 0 &&
    activeRoles.every((r) => r === "student" || r === "teacher");
  const nextDescription = isReader
    ? t.noPublishedBody
    : activeRoles.includes("scheduler")
      ? t.nextStepDescription
      : activeRoles.includes("admin")
        ? t.nextAdminDescription
        : t.nextApproverDescription;
  const upcomingItems = [
    { title: t.calendar, icon: "clock", permission: "calendar.manage" },
    { title: t.editor, icon: "calendar", permission: "draft.edit" },
    { title: t.generator, icon: "spark", permission: "generator.run" },
    { title: t.publication, icon: "layers", permission: "draft.approve" },
    { title: t.export, icon: "download", permission: "publication.export" },
  ] as const;
  const availableUpcoming = upcomingItems.filter((item) =>
    workspace.permissions.includes(item.permission),
  );
  const initials = user.display_name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p.charAt(0))
    .join("")
    .toLocaleUpperCase("kk-KZ");
  return (
    <div className="workspace-layout">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-divider" />
        <nav aria-label={t.navTitle}>
          <p className="nav-heading">{t.navTitle}</p>
          <a
            href="#main"
            className={view === "overview" ? "nav-current" : "import-nav"}
            aria-current={view === "overview" ? "page" : undefined}
            onClick={() => setView("overview")}
          >
            <Icon name="grid" size={20} />
            {t.overview}
            {view === "overview" && <span className="nav-dot" />}
          </a>
          {workspace.permissions.includes("import.source.read") && (
            <button
              className="import-nav"
              aria-current={view === "import" ? "page" : undefined}
              onClick={() => setView("import")}
            >
              <Icon name="file" size={20} />
              {t.import}
            </button>
          )}
          {availableUpcoming.length > 0 && (
            <>
              <p className="nav-heading next-nav-heading">{t.nextTitle}</p>
              <div className="upcoming-nav">
                {availableUpcoming.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    disabled
                    title={t.upcoming}
                  >
                    <Icon name={item.icon} size={19} />
                    <span>
                      {item.title}
                      <small>{t.upcoming}</small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="local-dot" />
          <div>
            <strong>{t.local}</strong>
            <span>{t.localHint}</span>
          </div>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-header">
          <div>
            <span className="breadcrumb-brand">{t.appName}</span>
            <span className="breadcrumb-separator">/</span>
            <span>{view === "import" ? t.import : t.overview}</span>
          </div>
          <div className="header-actions">
            <span className="language-label">
              Ққ <span>{t.language}</span>
            </span>
            <button
              className="button button-quiet"
              onClick={() => void onLogout()}
              disabled={busy}
            >
              <Icon name="logout" size={18} />
              <span>{busy ? t.signingOut : t.signOut}</span>
            </button>
          </div>
        </header>
        <nav className="mobile-workspace-nav" aria-label={t.navTitle}>
          <button
            aria-current={view === "overview" ? "page" : undefined}
            onClick={() => setView("overview")}
          >
            {t.overview}
          </button>
          {workspace.permissions.includes("import.source.read") && (
            <button
              aria-current={view === "import" ? "page" : undefined}
              onClick={() => setView("import")}
            >
              {t.import}
            </button>
          )}
        </nav>
        <main id="main" className="workspace-main" tabIndex={-1}>
          {error && (
            <p role="alert" className="error-message workspace-error">
              {error}
            </p>
          )}
          {view === "import" ? (
            <ImportPage
              scope={workspace.scope.id}
              csrfToken={csrfToken}
              canWrite={workspace.permissions.includes("import.write")}
              onExpired={onExpired}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">{t.appDescription}</p>
                  <h1>{t.overview}</h1>
                </div>
                {workspace.scope.is_demo && (
                  <span className="demo-tag">
                    <span />
                    {t.demo}
                  </span>
                )}
              </div>
              <section className="welcome-card" aria-labelledby="welcome-title">
                <div className="welcome-copy">
                  <span className="stage-pill">{t.stageLabel}</span>
                  <h2 id="welcome-title">{t.stageTitle}</h2>
                  <p>{t.stageDescription}</p>
                </div>
                <div className="welcome-icon" aria-hidden="true">
                  <Icon name="calendar" size={72} />
                  <span className="welcome-tick">
                    <Icon name="check" size={24} />
                  </span>
                </div>
              </section>
              {workspace.scope.is_demo && (
                <p className="demo-note">
                  <Icon name="alert" size={18} />
                  {t.demoDescription}
                </p>
              )}
              <section className="identity-grid" aria-label={t.accountLabel}>
                <article className="identity-card">
                  <span className="card-kicker">{t.accountLabel}</span>
                  <div className="person-line">
                    <span className="avatar" aria-hidden="true">
                      {initials}
                    </span>
                    <div>
                      <strong>{user.display_name}</strong>
                      <span>{user.email}</span>
                    </div>
                  </div>
                </article>
                <article className="identity-card">
                  <span className="card-kicker">
                    {activeRoles.length === 1 ? t.roleLabel : t.rolePlural}
                  </span>
                  <div className="role-line">
                    <span className="card-icon">
                      <Icon name="lock" size={21} />
                    </span>
                    <strong>
                      {activeRoles
                        .map((role) => roleNames[role] ?? t.unknownRole)
                        .join(", ")}
                    </strong>
                  </div>
                </article>
                <article className="identity-card">
                  <span className="card-kicker">{t.scopeLabel}</span>
                  <div className="role-line">
                    <span className="card-icon">
                      <Icon name="layers" size={21} />
                    </span>
                    <strong>{workspace.scope.name}</strong>
                  </div>
                </article>
              </section>
              <div className="workspace-columns">
                <section
                  className="panel permissions-panel"
                  aria-labelledby="permissions-title"
                >
                  <div className="panel-heading">
                    <span className="panel-icon">
                      <Icon name="lock" size={21} />
                    </span>
                    <div>
                      <h2 id="permissions-title">{t.accessTitle}</h2>
                      <p>{t.accessDescription}</p>
                    </div>
                  </div>
                  {workspace.permissions.length > 0 ? (
                    <ul className="permission-list">
                      {workspace.permissions.map((permission) => (
                        <li key={permission}>
                          <span className="permission-check">
                            <Icon name="check" size={15} />
                          </span>
                          <span>
                            {permissionNames[permission] ?? t.unknownPermission}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="empty-message">{t.noPermissions}</p>
                  )}
                  <div className="panel-footnote">
                    <Icon name="lock" size={14} />
                    {t.secureSession}
                  </div>
                </section>
                <div className="right-column">
                  <section className="panel stage-panel">
                    <span className="mini-kicker">{t.stageLabel}</span>
                    <h2>{t.currentStageTitle}</h2>
                    <ul className="stage-list">
                      {t.currentStageItems.map((item) => (
                        <li key={item}>
                          <Icon name="check" size={17} />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section className="next-step">
                    <span className="next-step-icon">
                      <Icon name={isReader ? "calendar" : "file"} size={22} />
                    </span>
                    <div>
                      <h2>{isReader ? t.noPublishedTitle : t.nextStepTitle}</h2>
                      <p>{nextDescription}</p>
                      <span className="upcoming-label">
                        <Icon name="clock" size={14} />
                        {t.upcoming}
                      </span>
                    </div>
                  </section>
                </div>
              </div>
              <footer className="workspace-footer">
                <span>{t.footer}</span>
                <span>{t.stageFooter}</span>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [session, setSession] = useState<Session>({
    user: null,
    csrf_token: "",
  });
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const receiveSession = useCallback(async (result: Session) => {
    setSession(result);
    if (!result.user) {
      setWorkspace(null);
      setScreen("login");
      return;
    }
    try {
      const loaded = await api.workspace(result.user.home_scope_id);
      setWorkspace(loaded);
      setError("");
      setNotice("");
      setScreen("workspace");
    } catch (problem) {
      setWorkspace(null);
      if (problem instanceof ApiError && problem.status === 401) {
        const refreshed = await api.session();
        setSession({ user: null, csrf_token: refreshed.csrf_token });
        setNotice(t.sessionExpired);
        setScreen("login");
      } else {
        setError(errorMessage(problem));
        setScreen("error");
      }
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setScreen("loading");
    setError("");
    try {
      await receiveSession(await api.session());
    } catch (problem) {
      setError(errorMessage(problem));
      setScreen("error");
    }
  }, [receiveSession]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Re-check the server session after returning to a tab; no local role is authoritative.
  useEffect(() => {
    function check() {
      if (document.visibilityState === "visible" && screen === "workspace")
        void api
          .session()
          .then(receiveSession)
          .catch((problem) => setError(errorMessage(problem)));
    }
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [screen, receiveSession]);

  async function logout() {
    setBusy(true);
    setError("");
    try {
      try {
        await api.logout(session.csrf_token);
      } catch (problem) {
        if (!(problem instanceof ApiError) || problem.code !== "CSRF_INVALID")
          throw problem;
        const refreshed = await api.session();
        setSession(refreshed);
        if (refreshed.user) await api.logout(refreshed.csrf_token);
      }
      setSession({ user: null, csrf_token: "" });
      setWorkspace(null);
      await bootstrap();
    } catch (problem) {
      if (problem instanceof ApiError && problem.status === 401)
        await bootstrap();
      else setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <a className="skip-link" href="#main">
        {t.skipLink}
      </a>
      {screen === "loading" && (
        <main id="main" className="state-screen">
          <Brand />
          <div className="loading-box" role="status">
            <span className="spinner" />
            {t.loading}
          </div>
        </main>
      )}
      {screen === "error" && (
        <main id="main" className="state-screen">
          <Brand />
          <div className="error-box">
            <Icon name="alert" size={28} />
            <p role="alert">{error}</p>
            <button
              className="button button-primary"
              onClick={() => void bootstrap()}
            >
              {t.retry}
            </button>
          </div>
        </main>
      )}
      {screen === "login" && (
        <Login
          session={session}
          notice={notice}
          onSuccess={receiveSession}
          onRefresh={async () => {
            const refreshed = await api.session();
            setSession({ user: null, csrf_token: refreshed.csrf_token });
          }}
        />
      )}
      {screen === "workspace" && session.user && workspace && (
        <WorkspaceScreen
          user={session.user}
          workspace={workspace}
          onLogout={logout}
          busy={busy}
          error={error}
          csrfToken={session.csrf_token}
          onExpired={() => void bootstrap()}
        />
      )}
    </>
  );
}
