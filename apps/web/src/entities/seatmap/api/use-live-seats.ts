'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '@/shared/api/client';
import { eventsControllerLayout, eventsControllerSeatmap, organizerEventsControllerLayout, organizerEventsControllerSeatmap } from '@/shared/api/generated/sdk.gen';
import { getSocket } from '@/shared/lib/socket';
import { observeServerTime, serverNow } from '@/shared/lib/server-clock';
import { useSession } from '@/shared/lib/session';
import { buildSeatIndex } from '../model/seat-index';
import { applyChanges, fromSnapshot, type SeatChange, type SeatState } from '../model/seat-state';

interface SubscribeAck {
  readonly ok: boolean;
  readonly seq?: number;
  readonly serverTime?: string;
  readonly resync?: boolean;
  readonly changes?: readonly SeatChange[];
}

/**
 * The hall with live statuses. REST gives the layout and a snapshot with its sequence number; the socket then delivers
 * changes (and, after a reconnect, everything missed since the last sequence number). Without a session the map is polled.
 */
export const useLiveSeats = (eventId: string, options: { readonly organizer?: boolean } = {}) => {
  const session = useSession();
  const qc = useQueryClient();
  const token = session.status === 'authenticated' ? session.accessToken : null;
  const organizer = options.organizer === true;
  const [state, setState] = useState<SeatState | null>(null);
  const [connected, setConnected] = useState(false);
  const [, forceTick] = useState(0);
  const stateRef = useRef<SeatState | null>(null);
  stateRef.current = state;

  const layoutQuery = useQuery({
    queryKey: ['seat-layout', eventId, organizer],
    queryFn: async () => {
      const res = organizer ? await organizerEventsControllerLayout({ client, path: { id: eventId }, throwOnError: true }) : await eventsControllerLayout({ client, path: { id: eventId }, throwOnError: true });
      return res.data;
    },
    staleTime: 60_000,
    enabled: token !== null || !organizer,
  });
  const index = useMemo(() => (layoutQuery.data ? buildSeatIndex(layoutQuery.data) : null), [layoutQuery.data]);
  const indexRef = useRef(index);
  indexRef.current = index;

  const fetchSnapshot = useCallback(async (): Promise<void> => {
    const res = organizer ? await organizerEventsControllerSeatmap({ client, path: { id: eventId }, throwOnError: true }) : await eventsControllerSeatmap({ client, path: { id: eventId }, throwOnError: true });
    observeServerTime(res.data.serverTime);
    setState((prev) => (prev && prev.seq > res.data.seq ? prev : fromSnapshot(res.data)));
  }, [eventId, organizer]);

  useEffect(() => {
    if (!index) return;
    void fetchSnapshot().catch(() => undefined);
  }, [index, fetchSnapshot]);

  useEffect(() => {
    if (!index) return;
    if (!token) {
      const timer = setInterval(() => void fetchSnapshot().catch(() => undefined), 4_000);
      return () => clearInterval(timer);
    }
    const socket = getSocket(token);
    const subscribe = (): void => {
      socket.emit('subscribe', { eventId, lastSeq: stateRef.current?.seq, admin: organizer || undefined }, (ack: SubscribeAck) => {
        if (!ack?.ok) return;
        if (ack.serverTime) observeServerTime(ack.serverTime);
        if (ack.resync || !stateRef.current) void fetchSnapshot().catch(() => undefined);
        else if (ack.changes?.length) setState((prev) => (prev && indexRef.current ? applyChanges(indexRef.current, prev, ack.changes ?? []) : prev));
      });
    };
    const onChanges = (message: { readonly eventId: string; readonly changes: readonly SeatChange[] }): void => {
      if (message.eventId !== eventId) return;
      setState((prev) => (prev && indexRef.current ? applyChanges(indexRef.current, prev, message.changes) : prev));
    };
    const onConnect = (): void => {
      setConnected(true);
      subscribe();
    };
    const onDisconnect = (): void => setConnected(false);
    socket.on('seat.changes', onChanges);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) onConnect();
    const refresh = setInterval(() => forceTick((n) => n + 1), 1_000); // holds that expire become free on screen without an event
    return () => {
      clearInterval(refresh);
      socket.off('seat.changes', onChanges);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.emit('unsubscribe', { eventId });
    };
  }, [index, token, eventId, organizer, fetchSnapshot]);

  useEffect(() => () => void qc.cancelQueries({ queryKey: ['seat-layout', eventId] }), [qc, eventId]);

  return { layout: layoutQuery.data ?? null, index, state, connected, loading: layoutQuery.isLoading, error: layoutQuery.error, serverNow: () => serverNow(), refresh: fetchSnapshot };
};
