'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import type { RealtimeChannel, User } from '@supabase/supabase-js';

type ChatMessage = { id: string; session_id: string; sender_id: string; body: string; created_at: string };
type ChatSession = { id: string; participant_a: string; participant_b: string; created_at: string };
const INTERESTS = ['Gaming', 'Music', 'Tech', 'Anime', 'Movies', 'Art', 'Night Talks', 'Philosophy', 'Fitness', 'Random'];

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [interests, setInterests] = useState<string[]>(['Music', 'Tech']);
  const [status, setStatus] = useState<'idle'|'searching'|'connected'|'error'>('idle');
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('Inappropriate behavior');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const sessionRef = useRef<string | null>(null);
  const userRef = useRef<string | null>(null);
  const searchRef = useRef(0); // bumped to cancel any in-flight polling loop

  const disconnectChannel = useCallback(async () => {
    if (channelRef.current) {
      try { await getSupabase().removeChannel(channelRef.current); } catch { /* cleanup best effort */ }
      channelRef.current = null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const boot = async () => {
      try {
        const supabase = getSupabase();
        const { data: { session: existing } } = await supabase.auth.getSession();
        let current = existing?.user ?? null;
        if (!current) {
          const { data, error: authError } = await supabase.auth.signInAnonymously();
          if (authError) throw new Error('Anonymous sign-in is disabled. In Supabase, enable Anonymous Sign-Ins under Authentication settings.');
          current = data.user;
        }
        if (alive && current) { setUser(current); userRef.current = current.id; }
      } catch (e) {
        if (alive) { setError(e instanceof Error ? e.message : 'Could not initialize the app.'); setStatus('error'); }
      }
    };
    void boot();
    return () => { alive = false; searchRef.current++; if (channelRef.current) void getSupabase().removeChannel(channelRef.current); };
  }, []);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  const openSession = useCallback(async (nextSession: ChatSession) => {
    const supabase = getSupabase();
    await disconnectChannel();
    sessionRef.current = nextSession.id;
    setSession(nextSession);
    setMessages([]);
    setStatus('connected');
    setNotice('You are connected. Keep it respectful.');
    const channel = supabase.channel(`vyro-session-${nextSession.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `session_id=eq.${nextSession.id}` }, payload => {
        const incoming = payload.new as ChatMessage;
        setMessages(prev => prev.some(m => m.id === incoming.id) ? prev : [...prev, incoming]);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_sessions', filter: `id=eq.${nextSession.id}` }, payload => {
        if ((payload.new as { ended_at?: string | null }).ended_at) {
          void disconnectChannel();
          setStatus('idle'); setSession(null); sessionRef.current = null; setMessages([]); setNotice('The other person disconnected. Find another match when you are ready.');
        }
      })
      .subscribe();
    channelRef.current = channel;
    // Load history after subscribing so no message is lost in between; merge and de-duplicate.
    const { data: oldMessages, error: loadError } = await supabase.from('messages').select('*').eq('session_id', nextSession.id).order('created_at', { ascending: true }).limit(100);
    if (!loadError && oldMessages && sessionRef.current === nextSession.id) {
      setMessages(prev => {
        const seen = new Set(prev.map(m => m.id));
        return [...(oldMessages as ChatMessage[]).filter(m => !seen.has(m.id)), ...prev]
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
      });
    }
  }, [disconnectChannel]);

  const startMatch = async () => {
    if (!user) { setError('Still connecting to the service. Please try again in a moment.'); return; }
    if (busy) return;
    const searchId = ++searchRef.current;
    setBusy(true); setError(''); setNotice(''); setMessages([]); setSession(null); sessionRef.current = null;
    try {
      await disconnectChannel();
      setStatus('searching');
      const supabase = getSupabase();
      // p_reset ends any stale session left over from a closed tab so the user starts fresh.
      const { data, error: matchError } = await supabase.rpc('find_vyro_match', { p_interests: interests, p_reset: true });
      if (matchError) throw new Error(/function|schema cache/i.test(matchError.message) ? 'Database setup is incomplete. Run supabase/schema.sql in the Supabase SQL Editor.' : matchError.message);
      if (searchId !== searchRef.current) return; // cancelled while waiting
      if (data?.session_id) {
        const { data: found, error: fetchError } = await supabase.from('chat_sessions').select('*').eq('id', data.session_id).single();
        if (fetchError || !found) throw new Error('A match was found but could not be loaded. Please try again.');
        await openSession(found as ChatSession);
      } else {
        setNotice('Searching for someone with similar interests. Keep this tab open; tap Search again if no match arrives.');
        // Polling re-enters the queue RPC (which also refreshes our queue entry); the database prevents self-matching.
        let attempts = 0;
        const poll = async () => {
          if (searchId !== searchRef.current || sessionRef.current || !userRef.current) return;
          attempts++;
          try {
            const { data: result, error: pollError } = await getSupabase().rpc('find_vyro_match', { p_interests: interests });
            if (pollError) throw pollError;
            if (searchId !== searchRef.current) return;
            if (result?.session_id) {
              const { data: found } = await getSupabase().from('chat_sessions').select('*').eq('id', result.session_id).single();
              if (found && searchId === searchRef.current && !sessionRef.current) await openSession(found as ChatSession);
            } else if (attempts < 20) {
              window.setTimeout(poll, 3000);
            } else {
              try { await getSupabase().rpc('leave_vyro_match', { p_session_id: null }); } catch { /* best effort */ }
              if (searchId === searchRef.current) { setStatus('idle'); setNotice('No match yet. Try again later or choose more interests.'); }
            }
          } catch { if (searchId === searchRef.current && !sessionRef.current) { setStatus('idle'); setError('Could not continue matching. Please try again.'); } }
        };
        window.setTimeout(poll, 3000);
      }
    } catch (e) {
      if (searchId === searchRef.current) { setStatus('error'); setError(e instanceof Error ? e.message : 'Matching failed. Please try again.'); }
    } finally { setBusy(false); }
  };

  const leaveMatch = async (showNotice = true) => {
    searchRef.current++; // stop any polling loop
    const current = sessionRef.current;
    await disconnectChannel();
    if (userRef.current) {
      try { await getSupabase().rpc('leave_vyro_match', { p_session_id: current }); } catch { /* the session or queue may already be closed */ }
    }
    sessionRef.current = null; setSession(null); setMessages([]); setStatus('idle');
    if (showNotice) setNotice('Disconnected. You can find another person whenever you like.');
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !session || !user || busy) return;
    if (body.length > 1000) { setError('Messages must be 1,000 characters or fewer.'); return; }
    setBusy(true); setError(''); setDraft('');
    try {
      const { error: sendError } = await getSupabase().from('messages').insert({ session_id: session.id, sender_id: user.id, body });
      if (sendError) throw sendError;
    } catch { setDraft(body); setError('Message not sent. Check your connection and try again.'); }
    finally { setBusy(false); }
  };

  const submitReport = async () => {
    if (!session || !user) return;
    try {
      const { error: reportError } = await getSupabase().from('reports').insert({ session_id: session.id, reporter_id: user.id, reason: reportReason });
      if (reportError) throw reportError;
      setReportOpen(false); setNotice('Report submitted. You have been disconnected.'); await leaveMatch(false);
    } catch { setError('The report could not be submitted. Please disconnect and try again.'); }
  };

  const toggleInterest = (interest: string) => setInterests(prev => prev.includes(interest) ? prev.filter(i => i !== interest) : [...prev, interest]);

  return <main className="shell">
    <header className="topbar"><a className="brand" href="#home" aria-label="VYRO home"><span className="brand-mark">V</span><span>VYRO<span className="brand-dot">.</span>CHAT</span></a><div className="top-status"><span className={`status-dot ${user ? 'online' : ''}`} />{user ? 'SYSTEM READY' : 'INITIALIZING'}</div><a className="safety-link" href="#safety">Safety</a></header>
    <div className="layout" id="home">
      <aside className="sidebar"><div className="side-eyebrow">YOUR SPACE</div><div className="side-active"><span className="side-icon">⌁</span><span>Live Match</span><span className="tiny-dot" /></div><a className="side-item" href="#interests"><span className="side-icon">⌕</span>Explore interests</a><a className="side-item" href="#safety"><span className="side-icon">⬡</span>Safety center</a><div className="sidebar-bottom"><div className="privacy-orb">✳</div><strong>Stay anonymous.</strong><p>Never share private details with strangers.</p><span className="privacy-label">● PRIVACY FIRST</span></div></aside>
      <section className="main-panel">
        <div className="welcome-row"><div><div className="eyebrow">ANONYMOUS CONNECTION PROTOCOL</div><h1>Meet. Match. <span>Connect.</span></h1><p className="subtitle">Talk to someone new. Find your kind of conversation.</p></div><div className="live-pill"><span className="status-dot online"/> LIVE NETWORK</div></div>
        <div className="workspace">
          <section className="discovery card" id="interests"><div className="card-head"><div><div className="section-index">01 / DISCOVERY</div><h2>Set your signal</h2><p>Pick interests to find someone on your wavelength.</p></div><div className="radar-icon"><span/><span/><span/><b>V</b></div></div>
            <div className="interest-grid">{INTERESTS.map(item => <button key={item} type="button" className={`interest-chip ${interests.includes(item) ? 'selected' : ''}`} onClick={() => toggleInterest(item)} aria-pressed={interests.includes(item)}><span className="chip-plus">{interests.includes(item) ? '✓' : '+'}</span>{item}</button>)}</div>
            <div className="selected-line"><span>{interests.length} INTEREST{interests.length === 1 ? '' : 'S'} SELECTED</span><span className="privacy-mini">◈ INTERESTS AREN'T A PROFILE</span></div>
            <button className="primary-button" onClick={startMatch} disabled={!user || busy || status === 'searching' || status === 'connected' || interests.length === 0}><span className="button-symbol">⌁</span>{status === 'searching' ? 'SEARCHING FOR A MATCH…' : 'FIND A STRANGER'}<span className="button-arrow">↗</span></button>
            {status === 'searching' && <button className="text-button" onClick={() => void leaveMatch(false)}>Cancel search</button>}
            <p className="fine-print">By connecting, you agree to keep conversations respectful and follow the safety rules.</p>
          </section>
          <section className="chat-card card"><div className="chat-head"><div className="avatar">{status === 'connected' ? 'N' : '✳'}</div><div className="chat-person"><strong>{status === 'connected' ? `Stranger ${session?.id.slice(0, 5).toUpperCase()}` : status === 'searching' ? 'Finding your match…' : 'Your next conversation'}</strong><span><i className={`status-dot ${status === 'connected' ? 'online' : ''}`}/>{status === 'connected' ? 'CONNECTED' : status === 'searching' ? 'SEARCHING NETWORK' : 'WAITING FOR CONNECTION'}</span></div>{status === 'connected' && <button className="icon-button" title="Report user" aria-label="Report user" onClick={() => setReportOpen(true)}>⚑</button>}</div>
            {status === 'connected' ? <><div className="match-banner"><span className="match-check">✦</span><div><strong>Match established</strong><p>You both came here to connect.</p></div><span className="encrypted">◈ PRIVATE</span></div><div className="messages" ref={scrollRef} aria-live="polite">{messages.length === 0 && <div className="empty-chat"><div className="empty-symbol">↗</div><strong>Break the ice.</strong><p>Say hello or ask what they’re interested in.</p></div>}{messages.map(message => <div key={message.id} className={`message-row ${message.sender_id === user?.id ? 'mine' : 'theirs'}`}><div className="message-bubble">{message.body}<time>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div></div>)}</div><form className="composer" onSubmit={sendMessage}><input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Type a message…" aria-label="Message" maxLength={1000}/><button type="submit" disabled={!draft.trim() || busy} aria-label="Send message">↗</button></form><div className="chat-actions"><span>Be kind. Don’t share personal information.</span><button onClick={() => void leaveMatch()}>NEXT STRANGER ↗</button></div></> : <div className={`chat-empty ${status === 'searching' ? 'is-searching' : ''}`}><div className="large-radar"><span className="radar-ring ring-one"/><span className="radar-ring ring-two"/><span className="radar-ring ring-three"/><span className="radar-core">{status === 'searching' ? '⌁' : 'V'}</span></div><div className="empty-label">{status === 'searching' ? 'SCANNING THE NETWORK' : 'YOUR NEXT STORY STARTS HERE'}</div><h3>{status === 'searching' ? 'Looking for your people.' : 'A stranger. A new perspective.'}</h3><p>{status === 'searching' ? 'Matching your interests with someone who’s online.' : 'Your chat will appear here once a match is found.'}</p><div className="chat-features"><span>◈ PRIVATE BY DESIGN</span><span>✳ INTEREST MATCHING</span></div></div>}
          </section>
        </div>
        {(error || notice) && <div className={`feedback ${error ? 'error' : ''}`} role="status"><span>{error ? '!' : '✦'}</span><p>{error || notice}</p><button onClick={() => {setError('');setNotice('');}} aria-label="Dismiss message">×</button></div>}
        <div className="safety-strip" id="safety"><div className="safety-icon">⬡</div><div><strong>Your safety comes first.</strong><p>Stay anonymous, keep it respectful, and leave any conversation that feels wrong.</p></div><button onClick={() => setNotice('Safety tip: never share your full name, address, passwords, financial details, or live location with strangers.')}>SAFETY TIPS ↗</button></div>
        <footer><span>VYRO.CHAT <i>© 2026</i></span><span>BUILT FOR REAL CONVERSATIONS <b>●</b></span></footer>
      </section>
    </div>
    {reportOpen && <div className="modal-backdrop" role="presentation"><section className="report-modal" role="dialog" aria-modal="true" aria-labelledby="report-title"><button className="modal-close" onClick={() => setReportOpen(false)} aria-label="Close report">×</button><div className="section-index">SAFETY CENTER / REPORT</div><h2 id="report-title">Report this user</h2><p>Choose the reason that best describes what happened.</p>{['Inappropriate behavior','Harassment or threats','Spam or promotional links','Possible scam','Other safety concern'].map(reason => <label className="report-option" key={reason}><input type="radio" name="reason" checked={reportReason === reason} onChange={() => setReportReason(reason)}/>{reason}</label>)}<button className="primary-button report-submit" onClick={submitReport}>SUBMIT REPORT & DISCONNECT ↗</button><p className="modal-note">Reports are stored for moderation review. Do not use this feature for jokes or false reports.</p></section></div>}
  </main>;
}
