import java.net.URI
import java.util.Properties
import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// The same app as ../android (com.addakhana.app, the same signing key), so
// phones get this one as an update. Debug builds install next to it as
// "Adda Khana Dev" (com.addakhana.app.dev).

// Release signing: the WebView app's keystore.properties (never committed).
val keystoreFile = rootProject.file("../android/keystore.properties")
val keystoreProps = Properties().apply { if (keystoreFile.exists()) keystoreFile.inputStream().use { load(it) } }

val appUrl = (findProperty("addaUrl") ?: "https://adda-api.clix.dpdns.org").toString().trimEnd('/')
val debugUrl = (findProperty("addaDebugUrl") ?: appUrl).toString().trimEnd('/')

android {
    namespace = "com.addakhana.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.addakhana.app"
        minSdk = 24
        targetSdk = 36
        versionCode = 101
        versionName = "2.1.0"
        buildConfigField("String", "APP_URL", "\"$appUrl\"")
        // The site's own https address, also in debug builds (YouTube's player wants a real https page).
        buildConfigField("String", "SITE_URL", "\"$appUrl\"")
        val site = URI(appUrl)
        manifestPlaceholders["addaScheme"] = site.scheme
        manifestPlaceholders["addaHost"] = site.host
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    signingConfigs {
        if (keystoreFile.exists()) {
            create("release") {
                val store = File(keystoreProps.getProperty("storeFile"))
                storeFile = if (store.isAbsolute) store else rootProject.file("../android/$store")
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            // Test against a server on this computer: ./gradlew installDebug -PaddaDebugUrl=http://localhost:4080
            // (with `adb reverse tcp:4080 tcp:4080`).
            buildConfigField("String", "APP_URL", "\"$debugUrl\"")
            val site = URI(debugUrl)
            manifestPlaceholders["addaScheme"] = site.scheme
            manifestPlaceholders["addaHost"] = site.host
            // -PshrinkDebug: shrunk like a release, to try the shrinker's rules on an emulator.
            if (project.hasProperty("shrinkDebug")) {
                // Not debuggable either: R8 then shrinks as fully as for a release.
                isDebuggable = false
                isMinifyEnabled = true
                proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            }
        }
        release {
            // Shrunk (the APK downloads from the host's own server on every update)...
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // ...and only the code real phones run (emulators are x86).
            ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
            if (keystoreFile.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        // java.time on Android 7 (minSdk 24).
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

/**
 * Firebase's settings as resources, read from the WebView app's
 * google-services.json (never committed), for every build: the
 * google-services plugin refuses a debug build whose package
 * (com.addakhana.app.dev) isn't in that file. Without the file the app
 * builds and works, just without push.
 */
abstract class FirebaseResources : DefaultTask() {
    @get:InputFiles
    abstract val config: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val out = outputDir.get().file("values/firebase.xml").asFile
        out.parentFile.mkdirs()
        val src = config.files.firstOrNull { it.exists() }
        if (src == null) {
            out.writeText("<resources />\n")
            return
        }
        @Suppress("UNCHECKED_CAST")
        val json = JsonSlurper().parse(src) as Map<String, Any?>
        val project = json["project_info"] as Map<String, Any?>
        val client = (json["client"] as List<Map<String, Any?>>).first {
            val info = it["client_info"] as Map<String, Any?>
            (info["android_client_info"] as Map<String, Any?>)["package_name"] == "com.addakhana.app"
        }
        val appId = (client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"]
        val apiKey = ((client["api_key"] as List<Map<String, Any?>>).first())["current_key"]
        fun res(name: String, value: Any?) = if (value == null) "" else "    <string name=\"$name\" translatable=\"false\">$value</string>\n"
        out.writeText(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<resources>\n" +
                res("google_app_id", appId) +
                res("gcm_defaultSenderId", project["project_number"]) +
                res("google_api_key", apiKey) +
                res("project_id", project["project_id"]) +
                res("google_storage_bucket", project["storage_bucket"]) +
                "</resources>\n",
        )
    }
}

val firebaseResources = tasks.register<FirebaseResources>("firebaseResources") {
    config.from(rootProject.file("../android/app/google-services.json"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(firebaseResources, FirebaseResources::outputDir)
    }
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.webrtc)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.hls)
    // Videos sent at standard quality are made smaller first.
    implementation(libs.media3.transformer)
    implementation(libs.media3.effect)
    implementation(libs.media3.ui.compose)
    implementation(libs.media3.okhttp)
    implementation(libs.media3.ui)
    implementation(libs.exifinterface)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
}
