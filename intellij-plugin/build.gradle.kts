plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.5.0"
}

group = "com.stefanochieli"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Built against IntelliJ IDEA 2024.2; works on every newer IDE of the IntelliJ Platform
        // (IDEA, Android Studio, WebStorm, PyCharm, ...) because it only uses stable APIs.
        intellijIdeaCommunity("2024.2.4")
    }
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    pluginConfiguration {
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null }
        }
    }
    // The zip is also attached to the GitHub Release (install from disk). The release
    // workflow publishes it to the JetBrains Marketplace with `publishPlugin` when the
    // secret JETBRAINS_PUBLISH_TOKEN is set (exposed as PUBLISH_TOKEN).
    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }
    buildSearchableOptions = false
}

tasks.test {
    useJUnitPlatform()
}
