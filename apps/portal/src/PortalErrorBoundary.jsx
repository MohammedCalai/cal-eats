import React from "react";
import { createManualPortalReload, portalRecovery } from "./portal-recovery.js";
import "./PortalErrorBoundary.css";

export default class PortalErrorBoundary extends React.Component {
  state = { recovery: null, reloading: false, reloadFailed: false };
  heading = React.createRef();
  reload = createManualPortalReload(() => window.location.reload());

  static getDerivedStateFromError(error) { return { recovery: portalRecovery(error) }; }
  componentDidCatch() { this.heading.current?.focus(); }

  handleReload = () => {
    const result = this.reload();
    if (result === "requested") this.setState({ reloading: true, reloadFailed: false });
    else if (result === "failed") this.setState({ reloadFailed: true });
  };

  render() {
    if (!this.state.recovery) return this.props.children;
    const { title, description } = this.state.recovery;
    return <main className="portal-recovery" aria-labelledby="portal-recovery-title">
      <section className="portal-recovery-card" role="alert">
        <p className="portal-recovery-brand">Cal-Eats workspace</p>
        <span className="portal-recovery-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.55-1.1L20 9M4 15l2.35 3.1A7 7 0 0 0 17.9 17"/></svg></span>
        <h1 id="portal-recovery-title" ref={this.heading} tabIndex={-1}>{title}</h1>
        <p>{description}</p>
        <p className="portal-recovery-warning">Reloading may discard changes you haven’t saved on this page.</p>
        {this.state.reloadFailed && <p className="portal-recovery-warning" role="status">Use your browser’s refresh button to reopen the workspace.</p>}
        <button type="button" className="primary" disabled={this.state.reloading} onClick={this.handleReload}>{this.state.reloading ? "Reloading…" : "Reload workspace"}</button>
        <a href="mailto:support@calai.info?subject=Cal-Eats%20workspace%20help">Contact Cal-Eats support</a>
      </section>
    </main>;
  }
}
