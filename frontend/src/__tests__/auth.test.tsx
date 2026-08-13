import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Login from '../pages/Login';
import Register from '../pages/Register';

vi.mock('../services/api', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
  },
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    me: vi.fn(),
  },
}));

const renderWithRouter = (component: React.ReactNode) =>
  render(<BrowserRouter>{component}</BrowserRouter>);

describe('Login Page', () => {
  it('renders the login page with branding', () => {
    renderWithRouter(<Login />);
    expect(screen.getByText('PaperPort')).toBeInTheDocument();
  });

  it('has email input', () => {
    renderWithRouter(<Login />);
    const emailInput = screen.getByPlaceholderText('Email');
    expect(emailInput).toBeInTheDocument();
    expect(emailInput).toHaveAttribute('type', 'email');
  });

  it('has password input', () => {
    renderWithRouter(<Login />);
    const passwordInput = screen.getByPlaceholderText('Password');
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('has a submit button', () => {
    renderWithRouter(<Login />);
    const button = screen.getByRole('button', { name: /sign in/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('type', 'submit');
  });

  it('has link to register page', () => {
    renderWithRouter(<Login />);
    expect(screen.getByText(/create.*account|sign up/i)).toBeInTheDocument();
  });
});

describe('Register Page', () => {
  it('renders the register page with branding', () => {
    renderWithRouter(<Register />);
    expect(screen.getByText('PaperPort')).toBeInTheDocument();
  });

  it('has full name input', () => {
    renderWithRouter(<Register />);
    expect(screen.getByPlaceholderText('Full Name')).toBeInTheDocument();
  });

  it('has email input', () => {
    renderWithRouter(<Register />);
    expect(screen.getByPlaceholderText('Email')).toBeInTheDocument();
  });
});
