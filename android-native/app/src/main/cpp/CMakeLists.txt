# Noise cancellation for calls and room voice: RNNoise (rnnoise/, BSD) and the app's JNI glue.
cmake_minimum_required(VERSION 3.22.1)
project(addanoise C)

file(GLOB RNNOISE_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/rnnoise/src/*.c)

add_library(addanoise SHARED noise_jni.c noise_core.c ${RNNOISE_SOURCES})
target_include_directories(addanoise PRIVATE rnnoise/include rnnoise/src)
# ARM phones get NEON (always on arm64, the NDK's default on armv7).
target_compile_options(addanoise PRIVATE -O3 -fvisibility=hidden -Wno-unused-function)
target_compile_definitions(addanoise PRIVATE RNNOISE_BUILD)
target_link_libraries(addanoise m)
# 16 KB pages (Android 15 on).
target_link_options(addanoise PRIVATE "-Wl,-z,max-page-size=16384")
