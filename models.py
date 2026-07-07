"""Pydantic models for the Pronunciation Coach API."""

from pydantic import BaseModel, Field
from typing import List, Optional, Literal


class WordAssessment(BaseModel):
    """Assessment of a single word's pronunciation."""

    word: str
    status: Literal["correct", "mispronounced", "unclear"]
    feedback: str = ""
    expected_ipa: str = ""


class PronunciationResult(BaseModel):
    """Complete pronunciation assessment result."""

    overall_score: int = Field(ge=0, le=100)
    fluency_score: int = Field(ge=0, le=100)
    clarity_score: int = Field(ge=0, le=100)
    words: List[WordAssessment]
    summary: str
    strengths: List[str]
    improvements: List[str]


class AnalysisResponse(BaseModel):
    """API response wrapper."""

    success: bool
    result: Optional[PronunciationResult] = None
    error: Optional[str] = None
