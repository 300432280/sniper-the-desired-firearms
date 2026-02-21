'use client';

import { useState, useEffect, useCallback } from 'react';
import { authApi, searchesApi, User, Search } from './api';

// ─── useAuth ──────────────────────────────────────────────────────────────────

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi
      .me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore errors on logout
    }
    setUser(null);
    window.location.href = '/';
  }, []);

  return { user, loading, setUser, logout };
}

// ─── useSearches ──────────────────────────────────────────────────────────────

export function useSearches() {
  const [searches, setSearches] = useState<Search[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await searchesApi.list();
      setSearches(data.searches);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleSearch = useCallback(
    async (id: string) => {
      try {
        const data = await searchesApi.toggle(id);
        setSearches((prev) =>
          prev.map((s) => (s.id === id ? { ...s, isActive: data.search.isActive } : s))
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to toggle alert');
      }
    },
    []
  );

  const deleteSearch = useCallback(async (id: string) => {
    try {
      await searchesApi.delete(id);
      setSearches((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete alert');
    }
  }, []);

  const toggleGroup = useCallback(async (groupId: string) => {
    try {
      const data = await searchesApi.toggleGroup(groupId);
      setSearches((prev) =>
        prev.map((s) => s.searchAllGroupId === groupId ? { ...s, isActive: data.isActive } : s)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle group');
    }
  }, []);

  const deleteGroup = useCallback(async (groupId: string) => {
    try {
      await searchesApi.deleteGroup(groupId);
      setSearches((prev) => prev.filter((s) => s.searchAllGroupId !== groupId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete group');
    }
  }, []);

  return { searches, loading, error, refresh, toggleSearch, deleteSearch, toggleGroup, deleteGroup };
}
