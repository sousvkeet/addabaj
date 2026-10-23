# WebRTC's native code finds its Java classes, fields and methods by name
# (its own, and those of jni_zero, which it loads them through).
-keep class org.webrtc.** { *; }
-keep class org.jni_zero.** { *; }
-dontwarn org.webrtc.**
-dontwarn org.jni_zero.**

# The YouTube player's page calls these by name (the default rules keep
# @JavascriptInterface methods; this keeps the bridge class whole too).
-keep class com.addakhana.app.watch.YouTubePlayer$Bridge { *; }

# Stack traces in crash reports stay readable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
