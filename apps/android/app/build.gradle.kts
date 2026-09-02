plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "pw.janus.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "pw.janus.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        val janusUrl = (project.findProperty("janusUrl") as String?) ?: "http://10.0.2.2:8788"
        buildConfigField("String", "JANUS_URL", "\"$janusUrl\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
