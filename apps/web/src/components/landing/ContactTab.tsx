'use client';

import { useEffect, useRef, useState } from 'react';

type Topic = 'question' | 'feedback' | 'sales';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUPPORT_EMAIL = 'support@nia.dev';

// "Talk to us" edge tab + drawer. Direct port of
// designs/contact-tab-snippet.html's markup (styles live in
// hero-story/niaHero.css, appended verbatim). Visibility (data-contact-show)
// is driven straight from useNiaHeroEngine's compute() onto <html> — this
// component never re-renders on scroll. Open/sent/form state is plain React
// state local to this component, mirrored onto <html> via
// data-contact-open/-sent so the ported CSS (which keys off those
// attributes) keeps working unchanged.
export default function ContactTab() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [topic, setTopic] = useState<Topic>('question');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launchRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      root.setAttribute('data-contact-open', '');
      const t = setTimeout(() => nameRef.current?.focus({ preventScroll: true }), 350);
      return () => clearTimeout(t);
    }
    root.removeAttribute('data-contact-open');
    setSent(false);
    launchRef.current?.focus({ preventScroll: true });
    return undefined;
  }, [open]);

  useEffect(() => {
    const root = document.documentElement;
    if (sent) root.setAttribute('data-contact-sent', '');
    else root.removeAttribute('data-contact-sent');
  }, [sent]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // useNiaHeroEngine's compute() toggles data-contact-show directly (no
  // React re-render) when scrolling back into the story. Watch for that so
  // the drawer closes too, instead of staying open behind a hidden tab.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      if (!root.hasAttribute('data-contact-show')) setOpen(false);
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-contact-show'] });
    return () => observer.disconnect();
  }, []);

  // Unmount-time cleanup only (component is rendered once for the page's
  // lifetime, but keep <html> tidy if that ever changes).
  useEffect(() => {
    return () => {
      const root = document.documentElement;
      root.removeAttribute('data-contact-open');
      root.removeAttribute('data-contact-sent');
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid work email.');
      return;
    }
    if (message.trim().length === 0) {
      setError('Enter a message.');
      return;
    }
    setError(null);
    setSending(true);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, name: name.trim(), email: email.trim(), message: message.trim() }),
      });
      if (!res.ok) throw new Error('request failed');
      setSent(true);
      setName('');
      setEmail('');
      setMessage('');
      setTopic('question');
    } catch {
      setError("Couldn't send — check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="nc-wrap">
      <button
        ref={launchRef}
        type="button"
        className="nc-launch"
        id="nc-launch"
        aria-expanded={open}
        aria-controls="nc-panel"
        onClick={() => setOpen((o) => !o)}
      >
        <i aria-hidden="true" />
        <span>Talk to us</span>
      </button>
      <div className="nc-scrim" id="nc-scrim" onClick={() => setOpen(false)} />
      <div className="nc-panel" id="nc-panel" role="dialog" aria-modal="false" aria-labelledby="nc-title">
        <div className="nc-head">
          <div>
            <small />
            <span id="nc-title">Talk to us</span>
          </div>
          <button type="button" className="nc-x" id="nc-close" aria-label="Close" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <form className="nc-form" id="nc-form" noValidate onSubmit={handleSubmit}>
          <fieldset className="nc-seg" aria-label="Topic">
            <input
              type="radio"
              name="nc-topic"
              id="nc-t1"
              value="question"
              checked={topic === 'question'}
              onChange={() => setTopic('question')}
            />
            <label htmlFor="nc-t1">Question</label>
            <input
              type="radio"
              name="nc-topic"
              id="nc-t2"
              value="feedback"
              checked={topic === 'feedback'}
              onChange={() => setTopic('feedback')}
            />
            <label htmlFor="nc-t2">Feedback</label>
            <input
              type="radio"
              name="nc-topic"
              id="nc-t3"
              value="sales"
              checked={topic === 'sales'}
              onChange={() => setTopic('sales')}
            />
            <label htmlFor="nc-t3">Sales</label>
          </fieldset>
          <label className="nc-f" htmlFor="nc-name">
            Name
            <input id="nc-name" ref={nameRef} name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="nc-f" htmlFor="nc-email">
            Work email
            <input
              id="nc-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="nc-f" htmlFor="nc-msg">
            Message
            <textarea
              id="nc-msg"
              name="message"
              placeholder="What are you trying to move, and where to?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          {error ? <p className="nc-err">{error}</p> : null}
          <button type="submit" className="nc-send" disabled={sending}>
            {sending ? 'Sending…' : 'Send message'}
          </button>
        </form>
        <div className="nc-done" aria-live="polite">
          <b>Thanks, message received.</b>
          We&apos;ll reply to your work email.
        </div>
        <div className="nc-mail">
          Prefer email? <span>{SUPPORT_EMAIL}</span>
        </div>
      </div>
    </div>
  );
}
