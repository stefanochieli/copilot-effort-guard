package com.stefanochieli.effortguard.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.stefanochieli.effortguard.core.EffortCore
import com.stefanochieli.effortguard.core.EffortView
import com.stefanochieli.effortguard.core.Level
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea

class EffortToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = EffortPanel(project)
        val content = ContentFactory.getInstance().createContent(JBScrollPane(panel), "", false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }
}

private fun hex(h: String): Color = Color.decode(h)

/** A row of equal rounded segments; the first `filled` ones use `color`. */
private class SegmentBar : JComponent() {
    var segments = 3
    var filled = 0
    var color: Color = Color.GRAY

    init {
        alignmentX = LEFT_ALIGNMENT
        preferredSize = Dimension(JBUI.scale(240), JBUI.scale(14))
        minimumSize = Dimension(JBUI.scale(60), JBUI.scale(14))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(14))
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        val gap = JBUI.scale(4)
        val n = segments.coerceAtLeast(1)
        val w = (width - gap * (n - 1)) / n
        for (i in 0 until n) {
            val x = i * (w + gap)
            g2.color = if (i < filled) color else JBColor.border()
            g2.fillRoundRect(x, 0, w, height, JBUI.scale(4), JBUI.scale(4))
        }
        g2.dispose()
    }
}

/** A thin progress bar: the run of clean turns towards the "task looks easy" threshold. */
private class CalmBar : JComponent() {
    var fraction = 0.0
    var color: Color = Color.GRAY

    init {
        alignmentX = LEFT_ALIGNMENT
        preferredSize = Dimension(JBUI.scale(240), JBUI.scale(6))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(6))
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g2.color = JBColor.border()
        g2.fillRoundRect(0, 0, width, height, height, height)
        g2.color = color
        g2.fillRoundRect(0, 0, (width * fraction.coerceIn(0.0, 1.0)).toInt(), height, height, height)
        g2.dispose()
    }
}

/** The last turns, one small square each: green clean, red struggling. */
private class Timeline : JComponent() {
    var turns: List<Boolean> = emptyList()

    init {
        alignmentX = LEFT_ALIGNMENT
        preferredSize = Dimension(JBUI.scale(240), JBUI.scale(22))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(22))
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        val size = JBUI.scale(10)
        val gap = JBUI.scale(3)
        val perRow = maxOf(1, (width + gap) / (size + gap))
        turns.forEachIndexed { i, struggled ->
            g2.color = hex(if (struggled) Level.WARN.hex else Level.OK.hex)
            g2.fillRoundRect((i % perRow) * (size + gap), (i / perRow) * (size + gap), size, size, 3, 3)
        }
        g2.dispose()
    }

    fun heightFor(width: Int): Int {
        val size = JBUI.scale(10)
        val gap = JBUI.scale(3)
        val perRow = maxOf(1, (width + gap) / (size + gap))
        val rows = maxOf(1, (turns.size + perRow - 1) / perRow)
        return rows * (size + gap)
    }
}

/** Content of the Effort Guard tool window; refreshed every time the monitor reads new state. */
class EffortPanel(project: Project) : JPanel(BorderLayout()), Disposable {
    private val monitor = project.service<EffortMonitor>()

    private val levelLabel = JBLabel()
    private val badgeLabel = JBLabel()
    private val countLabel = JBLabel()
    private val bar = SegmentBar()
    private val calmTitle = JBLabel()
    private val calmBar = CalmBar()
    private val timeline = Timeline()
    private val hintArea = JTextArea()
    private val sessionsArea = JTextArea()
    private val metaArea = JTextArea()
    private val resetButton = JButton("Reset after changing model / thinking")

    private val listener = Runnable {
        ApplicationManager.getApplication().invokeLater { render(monitor.view) }
    }

    init {
        border = JBUI.Borders.empty(10, 12)
        val column = JPanel()
        column.layout = BoxLayout(column, BoxLayout.Y_AXIS)
        column.isOpaque = false

        val header = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(8), 0))
        header.isOpaque = false
        header.alignmentX = LEFT_ALIGNMENT
        levelLabel.font = levelLabel.font.deriveFont(java.awt.Font.BOLD, levelLabel.font.size2D + 4f)
        badgeLabel.isOpaque = true
        badgeLabel.border = BorderFactory.createEmptyBorder(1, 8, 1, 8)
        badgeLabel.foreground = Color(0x0d1117)
        countLabel.foreground = UIUtil.getContextHelpForeground()
        header.add(levelLabel)
        header.add(badgeLabel)
        header.add(countLabel)

        for (area in listOf(hintArea, sessionsArea, metaArea)) {
            area.isEditable = false
            area.isOpaque = false
            area.lineWrap = true
            area.wrapStyleWord = true
            area.alignmentX = LEFT_ALIGNMENT
        }
        hintArea.border = BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(0, 3, 0, 0, JBColor.border()),
            JBUI.Borders.empty(6, 8),
        )
        metaArea.foreground = UIUtil.getContextHelpForeground()
        resetButton.alignmentX = LEFT_ALIGNMENT
        resetButton.toolTipText = "Use it after changing the model or the thinking effort: streaks start again from zero."
        resetButton.addActionListener { monitor.resetEvaluation() }

        fun title(text: String) = JBLabel(text).apply {
            foreground = UIUtil.getContextHelpForeground()
            font = font.deriveFont(font.size2D - 1f)
            alignmentX = LEFT_ALIGNMENT
            border = JBUI.Borders.emptyTop(12)
        }
        header.maximumSize = Dimension(Int.MAX_VALUE, header.preferredSize.height)
        calmTitle.alignmentX = LEFT_ALIGNMENT

        column.add(header)
        column.add(JPanel().apply { isOpaque = false; preferredSize = Dimension(0, JBUI.scale(8)); maximumSize = preferredSize })
        column.add(bar)
        column.add(title("CLEAN RUN"))
        column.add(calmTitle)
        column.add(calmBar)
        column.add(title("LAST TURNS"))
        column.add(timeline)
        column.add(JPanel().apply { isOpaque = false; preferredSize = Dimension(0, JBUI.scale(8)); maximumSize = preferredSize })
        column.add(hintArea)
        column.add(title("SESSIONS IN THIS FOLDER"))
        column.add(sessionsArea)
        column.add(resetButton)
        column.add(JPanel().apply { isOpaque = false; preferredSize = Dimension(0, JBUI.scale(8)); maximumSize = preferredSize })
        column.add(metaArea)
        add(column, BorderLayout.NORTH)

        monitor.addListener(listener)
        monitor.start()
        render(monitor.view)
    }

    private fun render(view: EffortView) {
        val color = hex(view.level.hex)
        levelLabel.text = view.level.label
        levelLabel.foreground = color
        val action = view.action
        badgeLabel.isVisible = action != null
        if (action != null) {
            badgeLabel.text = action.badge + (view.kind?.let { " · $it" } ?: "")
            badgeLabel.background = color
        }
        countLabel.text = "${view.streak}/${view.threshold} struggling turns in a row"
        bar.segments = view.segments
        bar.filled = view.filled
        bar.color = color
        calmTitle.text = "${view.calm}/${view.calmThreshold} clean turns in a row"
        calmBar.fraction = view.calm.toDouble() / view.calmThreshold.coerceAtLeast(1)
        calmBar.color = hex(Level.CALM.hex)
        timeline.turns = view.timeline
        val timelineHeight = maxOf(JBUI.scale(22), timeline.heightFor(maxOf(width - JBUI.scale(24), 100)))
        timeline.preferredSize = Dimension(timeline.preferredSize.width, timelineHeight)
        timeline.maximumSize = Dimension(Int.MAX_VALUE, timelineHeight)
        hintArea.isVisible = view.hint != null
        hintArea.text = view.hint.orEmpty()
        hintArea.border = BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(0, 3, 0, 0, color),
            JBUI.Borders.empty(6, 8),
        )
        val sessions = view.sessions.mapIndexed { i, s ->
            "${s.kind ?: s.source} / ${s.id}${if (i == 0) " (latest)" else ""}  ${EffortCore.ageText(s.last)}"
        }
        sessionsArea.text = if (sessions.isEmpty()) "-" else sessions.joinToString("\n") +
            "\nStreaks are counted per folder, shared by these sessions."
        val session = view.session?.let { "${it.source} / ${it.id}" } ?: "-"
        metaArea.text = "Session: $session\nFolder: ${view.cwd ?: "-"}\nLast activity: ${EffortCore.ageText(view.updated)}"
        revalidate()
        repaint()
    }

    override fun dispose() {
        monitor.removeListener(listener)
    }
}
