/* The app's side of noise cancellation (rtc/Rnnoise.kt): a canceller per stream of sound. */
#include <jni.h>
#include <stdint.h>

#include "noise_core.h"

JNIEXPORT jlong JNICALL
Java_com_addakhana_app_rtc_Rnnoise_create(JNIEnv *env, jclass cls) {
    (void)env;
    (void)cls;
    return (jlong)(intptr_t)nc_create();
}

JNIEXPORT void JNICALL
Java_com_addakhana_app_rtc_Rnnoise_destroy(JNIEnv *env, jclass cls, jlong handle) {
    (void)env;
    (void)cls;
    nc_destroy((NoiseCanceller *)(intptr_t)handle);
}

/* Cleans 10 ms in place: `frames` floats in a direct buffer (WebRTC's own memory). */
JNIEXPORT jfloat JNICALL
Java_com_addakhana_app_rtc_Rnnoise_process(JNIEnv *env, jclass cls, jlong handle, jobject buffer, jint frames) {
    (void)cls;
    float *buf = (float *)(*env)->GetDirectBufferAddress(env, buffer);
    jlong capacity = (*env)->GetDirectBufferCapacity(env, buffer);
    if (!handle || !buf || capacity < (jlong)frames * (jlong)sizeof(float)) return -1.0f;
    return nc_process((NoiseCanceller *)(intptr_t)handle, buf, frames);
}
