package com.stefanochieli.effortguard.ui

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import com.intellij.util.concurrency.AppExecutorUtil
import com.stefanochieli.effortguard.core.EffortCore
import com.stefanochieli.effortguard.core.EffortState
import com.stefanochieli.effortguard.core.EffortView
import com.stefanochieli.effortguard.core.Notice
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Polls the state written by the hooks every 2 seconds for the folder of this project,
 * keeps the current view for the status bar and the tool window, and shows the notifications.
 */
@Service(Service.Level.PROJECT)
class EffortMonitor(private val project: Project) : Disposable {
    @Volatile
    var view: EffortView = EffortCore.computeView(null)
        private set

    @Volatile
    private var currentDir: Path? = null
    private var previous: EffortState? = null
    private var task: ScheduledFuture<*>? = null
    private val listeners = CopyOnWriteArrayList<Runnable>()

    @Synchronized
    fun start() {
        if (task != null) return
        task = AppExecutorUtil.getAppScheduledExecutorService()
            .scheduleWithFixedDelay({ refresh() }, 0, 2, TimeUnit.SECONDS)
    }

    fun addListener(listener: Runnable) {
        listeners.add(listener)
    }

    fun removeListener(listener: Runnable) {
        listeners.remove(listener)
    }

    fun refresh() {
        try {
            val folders = listOfNotNull(project.basePath)
            val found = EffortCore.findState(EffortCore.readProjects(EffortCore.copilotHome(), folders), folders)
            val state = found?.state
            currentDir = found?.dir
            view = EffortCore.computeView(state, found?.raw)
            notify(EffortCore.shouldNotify(previous, state))
            previous = state
            listeners.forEach { it.run() }
        } catch (e: Exception) {
            thisLogger().warn("Effort Guard refresh failed", e)
        }
    }

    /** Starts the evaluation again, after changing model or thinking effort. */
    fun resetEvaluation() {
        val dir = currentDir
        if (dir == null) {
            show("No data for this folder yet, nothing to reset.", NotificationType.INFORMATION)
            return
        }
        try {
            EffortCore.resetProject(dir)
            previous = null
            refresh()
            show("Evaluation restarted.", NotificationType.INFORMATION)
        } catch (e: Exception) {
            show("Reset failed (${e.message}).", NotificationType.ERROR)
        }
    }

    /** Marks the last closed turn as a good ("up") or bad ("down") result; the same vote again removes it. */
    fun vote(kind: String) {
        val dir = currentDir
        if (dir == null) {
            show("No turn recorded for this folder yet.", NotificationType.INFORMATION)
            return
        }
        try {
            EffortCore.voteLast(dir, kind)
            refresh()
        } catch (e: Exception) {
            show("Vote failed (${e.message}).", NotificationType.ERROR)
        }
    }

    /** Asks the two thresholds and writes them in .effort-guard.json, read by the hooks. Runs on the EDT. */
    fun setThresholds() {
        val base = project.basePath
        if (base == null) {
            show("Open a project folder first.", NotificationType.INFORMATION)
            return
        }
        val folder = java.nio.file.Paths.get(base)
        val current = EffortCore.readConfig(folder)
        fun ask(title: String, value: Int, min: Int, max: Int): Int? {
            val text = com.intellij.openapi.ui.Messages.showInputDialog(
                project, "$title ($min-$max)", "Effort Guard Thresholds", null, value.toString(),
                object : com.intellij.openapi.ui.InputValidator {
                    override fun checkInput(s: String?) = s?.trim()?.toIntOrNull()?.let { it in min..max } == true
                    override fun canClose(s: String?) = checkInput(s)
                },
            ) ?: return null
            return text.trim().toInt()
        }
        val threshold = ask("Struggling turns in a row before the warning", (current["threshold"] as? Number)?.toInt() ?: view.threshold, 1, 100) ?: return
        val calm = ask("Clean turns in a row before suggesting a lighter model", (current["calmThreshold"] as? Number)?.toInt() ?: view.calmThreshold, 2, 1000) ?: return
        try {
            val file = EffortCore.writeConfig(folder, threshold, calm)
            show("Thresholds $threshold / $calm saved in ${file.fileName}; they apply from the next Copilot event.", NotificationType.INFORMATION)
        } catch (e: Exception) {
            show("Could not save the thresholds (${e.message}).", NotificationType.ERROR)
        }
    }

    private fun notify(notice: Notice?) {
        when (notice) {
            Notice.WARN -> show(view.messages.warn, NotificationType.WARNING)
            Notice.ESCALATE -> show(view.messages.escalate, NotificationType.WARNING)
            Notice.CALM -> show(view.messages.calm, NotificationType.INFORMATION)
            null -> Unit
        }
    }

    private fun show(message: String, type: NotificationType) {
        NotificationGroupManager.getInstance().getNotificationGroup("Effort Guard")
            .createNotification("Effort Guard: $message", type)
            .notify(project)
    }

    override fun dispose() {
        task?.cancel(false)
        listeners.clear()
    }
}
