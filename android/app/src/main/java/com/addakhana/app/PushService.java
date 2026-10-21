package com.addakhana.app;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Receives pushes from Firebase, even when the app is closed. */
public class PushService extends FirebaseMessagingService {
    @Override
    public void onNewToken(@NonNull String token) {
        Push.saveToken(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Push.handle(this, message.getData());
    }
}
