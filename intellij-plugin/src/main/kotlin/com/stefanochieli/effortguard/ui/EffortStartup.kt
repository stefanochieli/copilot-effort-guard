package com.stefanochieli.effortguard.ui

import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/** Starts the monitor when a project opens, so the notifications work even if no widget is shown. */
class EffortStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        project.service<EffortMonitor>().start()
    }
}
