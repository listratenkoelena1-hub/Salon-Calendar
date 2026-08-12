importScripts('https://www.gstatic.com/firebasejs/12.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.8.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyC5BecKxYxQ9V5qbmXBNkTsvnIZBtK_dx8",
  authDomain: "rosesnails-calendar.firebaseapp.com",
  projectId: "rosesnails-calendar",
  storageBucket: "rosesnails-calendar.firebasestorage.app",
  messagingSenderId: "1000239390265",
  appId: "1:1000239390265:web:d2ed45be53b233cf40f7e8"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || payload.data?.title || "Rose's Nails";
  const body = payload.notification?.body || payload.data?.body || "";
  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: payload.data || {},
    tag: 'calendar-message-' + (payload.data?.notificationId || Date.now())
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL('/', self.location.origin);
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(url.href);
    })
  );
});

﻿const CACHE_NAME = 'salon-cache-v4';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CALENDAR_NOTIFICATIONS') {
    event.waitUntil(
      self.registration.getNotifications({ includeTriggered: true }).then(notifications => {
        notifications.forEach(notification => notification.close());
      })
    );
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return null;
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  if (request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(request).then((networkResponse) => {
      if (!networkResponse || networkResponse.status !== 200) {
        return networkResponse;
      }
      return caches.open(CACHE_NAME).then((cache) => {
        cache.put(request, networkResponse.clone());
        return networkResponse;
      });
    }).catch(() =>
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(request);
      })
    )
  );
});

